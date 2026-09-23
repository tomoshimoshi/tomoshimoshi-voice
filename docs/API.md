# Contrato de la API

Referencia de [server/index.ts](../server/index.ts), [esquemas](../lib/validation.ts) y [tipos](../lib/types.ts). Los ejemplos describen datos; no ejecutan llamadas.

## Orígenes y autenticación

- Navegador: rutas `/api/*` del mismo origen de la web.
- Next.js: reenvía solo rutas permitidas al origen `VOICE_SERVER_URL`, eliminando el prefijo `/api`.
- Proveedores: usan directamente `PUBLIC_BASE_URL` para webhooks y `wss://…/media/:id` para audio.

Todas las rutas de negocio requieren `Authorization: Bearer <CALLORI_INTERNAL_TOKEN>` y `X-Callori-Identity`. La web construye esta última desde la sesión: JSON `{sub,email,emailVerified,exp}`, codificado en base64url, seguido de un punto y una firma HMAC-SHA256 en base64url. `exp` es una fecha en milisegundos y se firma para 30 segundos. El worker rechaza firmas inválidas, vencidas o con más de 35 segundos de futuro.

Nunca generar esta firma ni exponer el secreto en componentes del navegador. Los callbacks de proveedores no requieren identidad de usuario; usan sus propios controles. Todas las respuestas JSON del worker incluyen `Cache-Control: no-store`.

## Rutas de negocio

| Método y ruta del worker | Entrada | Respuesta normal |
| --- | --- | --- |
| `GET /state` | — | Hasta 50 llamadas resumidas, perfil, wallet, `hasMoreCalls`, `profileComplete`, `emailVerified`, `readiness` |
| `GET /calls` | Query `limit` (1–100; 50 por defecto), `before` (ISO), `beforeId` (UUID) | Array de llamadas resumidas del usuario, sin transcripción |
| `POST /calls` | `CallInput` y `Idempotency-Key` UUID | 201 con llamada; 200 si la clave ya tiene una llamada |
| `GET /calls/:id` | UUID | Llamada completa, transcripción y resultado |
| `POST /calls/:id/answer` | `{questionId, answer}` | Llamada actualizada |
| `POST /calls/:id/cancel` | Sin campos de negocio | Llamada tras solicitar terminación y persistir estado |
| `PUT /profile` | Perfil completo validado | Perfil guardado |
| `GET /contacts` | — | Contactos del usuario |
| `POST /contacts` | `{placeId, country: "JP"}` | Lista tras guardar |
| `POST /contacts/remove` | `{placeId, country: "JP"}` | Lista tras eliminar |
| `GET /maps-config` | — | `{key, mapId}`; clave de navegador restringida, no secreto de servidor |
| `GET /wallet` | — | Saldo disponible/reservado, tarifa, mínimo y paquetes |
| `POST /billing/checkout` | `{packageCode}` y `Idempotency-Key` UUID | `{url, paymentId}` |
| `GET /billing/payments/:id` | UUID | `{id, status, amount, currency}` del propietario |

Las mutaciones a través del proxy requieren el origen web exacto y `Content-Type: application/json`, incluso si la cancelación no necesita campos. No existe una API HTTP de reembolso ni de conciliación administrativa.

Para paginar llamadas, usar conjuntamente `createdAt` e `id` del último elemento como `before` y `beforeId`; así no se pierden llamadas con la misma fecha.

## Datos de una llamada

```json
{
  "phone": "+817012345678",
  "objective": "Consultar disponibilidad para una cita",
  "context": "Primera visita. Solo necesito conocer horarios.",
  "constraints": "No confirmar una reserva sin preguntarme.",
  "language": "ja",
  "mode": "live",
  "shareProfile": false,
  "scenario": "appointment"
}
```

Ejemplo ficticio; sustituir el destino solo dentro de una prueba telefónica autorizada. El objeto es estricto: no acepta campos adicionales ni importes o IDs de usuario enviados por el cliente.

- `phone`: número admitido por la política de destinos; la UI normaliza a E.164.
- `objective`: 5–1500 caracteres; `context`: hasta 4000; `constraints`: hasta 2000.
- `language`: `ja`, `en` o `es`; es el idioma hablado, independiente del idioma de interfaz.
- `mode`: solo `live` para llamadas nuevas; los tipos conservan `demo` para historial heredado.
- `shareProfile`: booleano requerido, guardado como consentimiento de esta llamada.
- `scenario`: `appointment`, `restaurant`, `inquiry`, `followup` o `custom`.

El backend exige correo verificado, perfil completo, disponibilidad del servicio, destino permitido, ausencia de otra llamada activa del usuario y crédito suficiente. Una clave repetida devuelve la llamada ya creada: no usar una clave anterior para una intención nueva.

Para contestar:

```json
{
  "questionId": "00000000-0000-4000-8000-000000000001",
  "answer": "Sí, puedes confirmar ese horario."
}
```

La respuesta admite 1–2000 caracteres y debe corresponder a la pregunta vigente. El estado `waiting` conserva la llamada y la sesión de audio.

El perfil contiene `firstName`, `lastName`, `preferredName`, `age`, `sex`, `nationality` y `uiLanguage`. Guardar un perfil incompleto es válido; marcar exige nombre y apellidos. La ruta no acepta correo ni identificadores de cuenta.

## Saldo y Checkout

Los importes de respuesta son **cadenas de enteros en yenes**, para no perder precisión al serializar valores `bigint`. `approximateMinutes` es una estimación, no un paquete de minutos adquirido. `minimumCallCredit` corresponde a 30 segundos según la tarifa activa.

Paquetes admitidos: `credit_1000`, `credit_2000`, `credit_5000`. El backend decide los Price IDs y los importes. La URL de retorno de Checkout no prueba que el pago haya sido confirmado; consultar pago/wallet. Ver [facturación](BILLING.md).

## Rutas públicas de máquina

| Ruta | Protección y semántica |
| --- | --- |
| `GET /healthz` | Sin token; 200 `{status:"ok"}` o 503 durante arranque, apagado o fallo de almacenamiento |
| `POST /webhooks/telnyx` | Firma `telnyx-signature-ed25519` y `telnyx-timestamp`, cuerpo original; eventos correlacionados por llamada |
| `POST /webhooks/stripe` | `stripe-signature` sobre cuerpo original; evento y confirmación del pago validados |
| `WS /media/:id?token=…` | Upgrade autorizado por token aleatorio de la sesión; no usar bearer/identidad de usuario como sustituto |

El socket procesa eventos Telnyx `start`, `media`, `mark`, `stop` y `error`. `start` debe indicar PCMU/8000 y un control de llamada coherente. El worker envía `media`, `mark` y `clear`. No es una API de audio para el navegador.

El límite de cuerpo es 32 KiB para peticiones normales y Telnyx; Stripe admite 256 KiB. El proxy web limita sus cuerpos a 32 KiB. El socket Telnyx limita cada mensaje a 1 MiB. No registrar URLs de medios completas: contienen un token efímero.

## Errores y disponibilidad

Las respuestas fallidas usan `{ "error": "CODIGO" }`. La clasificación HTTP implementada es:

| HTTP | Ejemplos |
| --- | --- |
| 400 | `INVALID_INPUT`; `INVALID_SIGNATURE` de Stripe |
| 401 | `UNAUTHORIZED`; `INVALID_SIGNATURE` de Telnyx |
| 403 | `EMAIL_UNVERIFIED`; el proxy también produce `INVALID_ORIGIN` o `EMAIL_REQUIRED` |
| 404 | `NOT_FOUND`, incluidas llamadas o pagos de otra persona |
| 409 | `PROFILE_REQUIRED`, `ACTIVE_CALL`, `INSUFFICIENT_CREDIT`, `NOT_CONFIGURED`, `NUMBER_NOT_ALLOWED`, `STALE_QUESTION`, `RECOVERY_PENDING`, `CALL_ENDED`, `IDEMPOTENCY_CONFLICT` y otros conflictos conocidos |
| 413 | `BODY_TOO_LARGE`; el proxy puede responder `INVALID_INPUT` al detectar el tamaño declarado |
| 415 | `INVALID_INPUT` del proxy si la mutación no es JSON |
| 429 | `RATE_LIMIT` |
| 503 | `SERVICE_UNAVAILABLE`, `BILLING_NOT_CONFIGURED`, `CHECKOUT_UNAVAILABLE`, `PRICING_NOT_CONFIGURED` |
| 500 | `INTERNAL_ERROR` para fallos no expuestos al cliente |

`readiness.ready` combina presencia de configuración de telefonía, `LIVE_CALLS_ENABLED`, callback HTTPS, recuperación y salud de persistencia. No valida las credenciales contra los proveedores, el saldo individual ni Stripe. `/healthz=200` y `ready=true` no sustituyen una prueba de audio.

Los webhooks pueden repetirse y llegar desordenados; no duplicar manualmente operaciones de saldo para compensarlos. Una cancelación puede mantener un cuelgue pendiente si Telnyx no lo confirma. Consultar el estado y el procedimiento de [operaciones](OPERATIONS.md).

## Límites y errores adicionales · revisión 2026-09-23

Después de verificar la identidad, la API aplica 180 peticiones/minuto por `sub`; consultar pagos admite 20/minuto por cuenta. Responder/cancelar usa un presupuesto independiente de 60/minuto para no competir con el polling. Devuelve `429 API_RATE_LIMIT` y `Retry-After: 60`. Es un límite en memoria de un worker único, que se reinicia con el proceso y no sustituye protección contra inundación de tráfico en el proveedor.

Checkout admite 10 claves nuevas por cuenta en 30 minutos, comprobadas bajo el bloqueo transaccional del usuario en PostgreSQL (`429 CHECKOUT_RATE_LIMIT`). Las claves existentes conservan su comportamiento idempotente; nunca se crea saldo por una redirección del navegador. IDs de recurso malformados devuelven `400 INVALID_INPUT`.

El proxy web solo permite el método de cada operación y nunca sigue redirecciones del worker. `/profile` solo acepta PUT; `/contacts/remove`, `/billing/checkout`, `/calls/:id/answer` y `/calls/:id/cancel` solo aceptan POST. Los GET de salud/callbacks no usan la identidad de navegador.
