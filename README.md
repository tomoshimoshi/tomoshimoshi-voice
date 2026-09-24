# ToMoshiMoshi Voice

Servidor Node.js que realiza llamadas en nombre del usuario, conecta el audio de Telnyx con OpenAI Realtime y guarda el estado en PostgreSQL. También gestiona perfiles, contactos, crédito y facturación. La interfaz Next.js y Auth0 viven en [tomoshimoshi](https://github.com/tomoshimoshi/tomoshimoshi).

**Documentación:** [proyecto](docs/PROJECT.md) · [arquitectura y diagramas](docs/ARCHITECTURE.md) · [API](docs/API.md) · [índice completo](docs/README.md).

## Cómo funciona

1. La web valida la sesión y envía la solicitud con una identidad firmada.
2. El worker valida datos, registra consentimiento y reserva crédito antes de marcar.
3. Telnyx conecta con el teléfono y envía audio al worker; OpenAI mantiene la conversación.
4. El usuario sigue la transcripción y contesta preguntas privadas desde la web.
5. El worker guarda el resultado y liquida el cargo con evidencia del proveedor.

El audio no pasa por Vercel ni por el navegador del usuario. Los sockets viven en este proceso; un reinicio no puede conservar una llamada activa. Ver [arquitectura](docs/ARCHITECTURE.md).

## Producción

| Componente | Ubicación |
| --- | --- |
| Web | https://www.tomoshimoshi.com · Vercel |
| Voz | https://voice-production-53b8.up.railway.app · Railway |
| Código del worker | Este repositorio, rama `main`, servicio `voice` |
| Datos | Neon PostgreSQL |

Se reutilizan el dominio y las variables del servicio existente. Los webhooks son `/webhooks/telnyx` y `/webhooks/stripe`, directamente en voz. La API de negocio requiere bearer e identidad firmada; los callbacks tienen su propia validación.

## Desarrollo local

Usar Node 24 y una base PostgreSQL de desarrollo:

```sh
nvm use
npm ci
cp .env.example .env  # solo en la primera configuración
# Completar las variables antes de continuar.
npm run db:migrate
npm run dev
```

En la web, ejecutar `npm run dev` por separado y configurar `VOICE_SERVER_URL=http://127.0.0.1:3001`. Ambos repositorios deben usar el mismo `CALLORI_INTERNAL_TOKEN` explícito y `APP_BASE_URL=http://localhost:3000`.

Mantener `LIVE_CALLS_ENABLED=false` durante el desarrollo ordinario. No iniciar un worker local contra la base que utiliza Railway: solo puede haber un worker por base. No repetir la importación SQLite por haber separado los repositorios. Instrucciones completas en [desarrollo](docs/DEVELOPMENT.md).

## Comandos

| Comando | Uso |
| --- | --- |
| `npm start` | Ejecutar solo el servidor de voz |
| `npm run check` | Lint, tipos y pruebas aisladas |
| `npm run test:integration` | Pruebas HTTP aisladas, incluidas también en la suite normal |
| `npm run test:billing:postgres` | Concurrencia con PostgreSQL nativo desechable; necesita `BILLING_TEST_DATABASE_URL` |
| `npm run db:migrate` | Aplicar migraciones pendientes |
| `npm run db:import-sqlite` | Importación heredada explícita de una sola ejecución |
| `npm run backup -- /ruta/privada/tomoshimoshi.dump` | Backup PostgreSQL con `pg_dump` |
| `npm run billing:reconcile` | Informe de conciliación de solo lectura; variantes en [BILLING](docs/BILLING.md) |

No hay un comando `build`: Docker ejecuta el TypeScript con `tsx`. CI usa Node 24, pruebas aisladas, PostgreSQL 17 para concurrencia y auditoría de dependencias.

## Despliegue y límites

Seguir [Railway](docs/RAILWAY.md) y [operaciones](docs/OPERATIONS.md). Una réplica, sin suspensión y sin despliegues automáticos; detener el worker anterior antes de desplegar su sustituto. No quitar el bloqueo exclusivo para simular un rolling deployment.

Stripe admite `STRIPE_MODE=test|live`; en producción el modo predeterminado es live. Las claves, Prices, sesiones y webhooks deben pertenecer al mismo modo. Usar una base separada para pruebas. Configuración válida y healthcheck correcto no verifican el abono tras una compra real ni la calidad de audio. Las pruebas automatizadas no hacen llamadas ni pagos reales.

`lib/` conserva copias de los modelos y la identidad compartidos con la web; no hay un paquete compartido ni sincronización automática. Coordinar los cambios de contrato y el catálogo público como se indica en [desarrollo](docs/DEVELOPMENT.md).

El servicio se extrajo del repositorio web en la revisión `5d4ff2a`; el primer commit independiente es `35e330b`. Esa extracción conservó sin cambios el código del worker, los scripts y las migraciones.

## Contacto y reportes por correo

`POST /support` recibe `{ kind: "bug" | "contact", message, locale, callId? }`
con la identidad firmada habitual. Envía a `leodcastaneda@gmail.com` mediante
SendGrid; `reply_to` es el correo autenticado. Configurar `SENDGRID_API_KEY`
(permiso Mail Send) y `SENDGRID_FROM_EMAIL=contact@tomoshimoshi.com` en este servicio,
con el dominio o remitente autenticado en SendGrid. Sin esas variables devuelve
`503 SUPPORT_NOT_CONFIGURED` sin afectar las llamadas.

Valida propiedad de la llamada, texto de 10–5000 caracteres y 5 intentos por
cuenta cada 15 minutos. El correo incluye referencia/estado de la llamada, sin
transcripciones ni números telefónicos. `202` indica aceptación de SendGrid,
no entrega; los logs `support.queued` y `support.failed` permiten correlacionar
el resultado con la referencia. Las pruebas simulan SendGrid y no envían correos.

## Reparto del trabajo y evaluación actual

| Web (`tomoshimoshi`) | Voice (este repositorio) |
| --- | --- |
| Next.js, páginas y UI EN/ES/JA | API de negocio y persistencia PostgreSQL |
| Sesión Auth0, origen/CSRF y proxy con identidad HMAC | Verificación del bearer + identidad y autorización por propietario |
| Wizard, Maps, fechas y consentimiento visible | Validación de perfil/correo/destino, consentimiento registrado y reserva atómica |
| Transcripción visible, respuestas y botón de cancelar | Telnyx, OpenAI Realtime, traducción, preguntas, audio, cuelgue y recuperación |
| Saldo/paquetes y redirección a Checkout | Stripe, catálogo autorizado, ledger, reservas, liquidación y reversos |

La UI nunca autoriza un cobro ni marca por sí misma. Las reglas se imponen aquí aunque el navegador envíe solicitudes manuales. Los endpoints de negocio no aceptan el `user_id` del navegador: usan el `sub` firmado por la web. El audio va entre Telnyx, este proceso y OpenAI; no pasa por Vercel ni utiliza el micrófono del usuario.

`server/index.ts` define la frontera HTTP; `server/engine.ts` conserva sesiones activas y controla la conversación; `server/providers.ts` encapsula Telnyx/OpenAI; `server/store.ts` aplica propiedad de datos; `server/{wallet,calls,billing,pricing}/` gestiona dinero. Las migraciones viven en `db/migrations/`. Los límites por cuenta están en `server/rate-limit.ts`: 180 peticiones/minuto, 20 consultas de pago/minuto y 60 controles de llamada/minuto en un presupuesto independiente; la creación de pagos añade un límite persistente de 10 claves nuevas/30 minutos, conservando reintentos idempotentes.

Los cambios de reglas y datos empiezan en Voice; los cambios de presentación, en Web. Para cambios de contrato actualizar ambos `lib/` y pruebas, desplegar primero un backend compatible con los clientes antiguos y después la UI. Desde la web, `npm run check:contracts -- ../tomoshimoshi-voice` compara los siete helpers compartidos y el catálogo. No es una sincronización ni sustituye pruebas de integración.

Ver [assessment del servicio](docs/ASSESSMENT-2026-09-23.md) y [assessment integral de la aplicación](https://github.com/tomoshimoshi/tomoshimoshi/blob/main/docs/ASSESSMENT-2026-09-23.md). Los cambios del assessment están preparados localmente; su validación no implica despliegue. El soporte live descrito en [la auditoría anterior de Stripe](docs/STRIPE-PRODUCTION-AUDIT.md) sustituye las referencias antiguas a “solo test”.
