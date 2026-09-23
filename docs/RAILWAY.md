# Voz en Railway, web en Vercel

La web continúa en `https://www.tomoshimoshi.com`. Railway ejecuta únicamente
`server/index.ts`; Neon conserva los datos y Auth0 gestiona el acceso a la web.
Ngrok deja de ser necesario en producción.

Direcciones de producción:

- Web: `https://www.tomoshimoshi.com`.
- Voz: `https://voice-production-53b8.up.railway.app`.
- Webhook Telnyx v2: `https://voice-production-53b8.up.railway.app/webhooks/telnyx`.

El servicio `voice` usa la rama `main` de
`tomoshimoshi/tomoshimoshi-voice`.
El despliegue web de Vercel sigue usando `main`.

## Crear el servicio

1. Crear un servicio en Railway desde `tomoshimoshi/tomoshimoshi-voice`, usando una revisión
   que incluya `Dockerfile`. Mantener la raíz del repositorio
   como directorio raíz del servicio.
2. Railway detecta `Dockerfile` y construye la imagen de Node 24. En Settings,
   configurar Healthcheck Path `/healthz`, timeout 120 segundos, reinicio
   `ON_FAILURE` (10 intentos), overlap 0 y draining 30 segundos. La imagen ejecuta
   solo el worker. Los servicios nuevos ya no admiten `railway.json`.
   No configurar `npm start` ni `npm run build`: son comandos de la web.
   Dejar vacío el override de Start Command para usar el CMD de la imagen.
3. Configurar **una sola réplica en una sola región**, sin Serverless/suspensión
   y sin despliegues automáticos al hacer push. Elegir la región teniendo en
   cuenta la ubicación de Neon y de los proveedores de audio.
4. Añadir las variables indicadas abajo. No copiar `.env` completo:
   contiene direcciones y opciones del entorno local.
5. En Networking, generar un dominio público de Railway. El servicio escucha
   en `0.0.0.0` y en el `PORT` asignado por Railway. No añadir `:3001` a la URL.
   Configurar `PUBLIC_BASE_URL` con ese origen HTTPS.
6. Antes del primer arranque contra producción, terminar las llamadas y detener
   cualquier worker local que use esa misma base. El bloqueo exclusivo de
   PostgreSQL impide ejecutar ambos a la vez.
7. Desplegar y comprobar que `https://DOMINIO-RAILWAY/healthz` devuelve
   `{"status":"ok"}`. Confirma arranque y acceso a la base, no conectividad
   con OpenAI, Telnyx o Stripe.

No se necesita volumen persistente: los datos están en Neon y el secreto interno
se configura explícitamente. `.dockerignore` excluye credenciales y archivos
locales del contexto de construcción.

## Variables en Railway

Configurar secretos en Variables de Railway, nunca en Git ni en el navegador.

| Variable | Valor o finalidad |
| --- | --- |
| `DATABASE_URL` | Conexión **directa** a Neon, necesaria para el bloqueo del worker. No usar la URL del pool aquí. |
| `DATABASE_URL_POOLED` | Conexión con pool a la **misma** base Neon para consultas habituales. |
| `CALLORI_INTERNAL_TOKEN` | El mismo secreto de al menos 32 caracteres sin espacios que usa Vercel. |
| `APP_BASE_URL` | `https://www.tomoshimoshi.com`, el origen canónico exacto configurado en Vercel/Auth0. |
| `PUBLIC_BASE_URL` | `https://DOMINIO-RAILWAY`, sin rutas; después puede ser `https://voice.tomoshimoshi.com`. |
| `OPENAI_API_KEY` | Clave del proyecto OpenAI existente. |
| `OPENAI_REALTIME_MODEL` | Opcional, conservar el modelo validado; por defecto `gpt-realtime`. |
| `OPENAI_TEXT_MODEL` | Opcional, por defecto `gpt-4.1-mini`. |
| `TELNYX_API_KEY` | Clave Telnyx existente. |
| `TELNYX_CONNECTION_ID` | Aplicación Voice API / Call Control existente. |
| `TELNYX_FROM_NUMBER` | Número de origen autorizado, formato E.164. |
| `TELNYX_PUBLIC_KEY` | Clave pública para verificar las firmas de callbacks. |
| `ALLOWED_PHONE_NUMBERS` | Destinos autorizados existentes; `*` permite los países habilitados por la aplicación. |
| `LIVE_CALLS_ENABLED` | `false` durante la configuración; `true` al probar telefonía. |
| `MAX_CALL_SECONDS` | Conservar el límite elegido; por defecto 600. |
| `STRIPE_MODE` | `live` en producción; `test` únicamente con base y claves aisladas. |
| `STRIPE_SECRET_KEY` | Clave restringida **live** `rk_live_…` con los permisos indicados en BILLING.md. |
| `STRIPE_WEBHOOK_SECRET` | Secreto del nuevo endpoint HTTPS; no reutilizar el de `stripe listen`. |
| `STRIPE_PRICE_CREDIT_1000` | Price live existente de ¥1.000. |
| `STRIPE_PRICE_CREDIT_2000` | Price live existente de ¥2.000. |
| `STRIPE_PRICE_CREDIT_5000` | Price live existente de ¥5.000. |
| `GOOGLE_MAPS_BROWSER_KEY` | Opcional, clave de navegador restringida a los dominios autorizados de la web. |
| `GOOGLE_MAPS_MAP_ID` | Opcional, ID de mapa existente. |

La imagen establece `NODE_ENV=production` y `VOICE_HOST=0.0.0.0`.
No sobreescribirlos con valores locales ni fijar `VOICE_PORT`: Railway proporciona
`PORT`, que tiene prioridad. Railway no necesita los secretos de Auth0.

Las migraciones no se ejecutan automáticamente al construir o arrancar la imagen.
Verificar que Neon tiene aplicadas las migraciones del repositorio, incluidas
`003_billing.sql` y `004_live_payments.sql`. Si falta alguna, ejecutar `npm run db:migrate` con la conexión
directa en mantenimiento antes de arrancar el worker. No volver a importar SQLite.
Ver [PostgreSQL](POSTGRESQL.md) y [facturación](BILLING.md).

## Conectar Vercel

En las variables de **Production** del proyecto web:

```dotenv
VOICE_SERVER_URL=https://DOMINIO-RAILWAY
APP_BASE_URL=https://www.tomoshimoshi.com
CALLORI_INTERNAL_TOKEN=EL_MISMO_SECRETO_QUE_EN_RAILWAY
```

Conservar las variables Auth0 y comprobar que permiten el origen de producción
y su callback `/auth/callback`. Redesplegar la web para aplicar las variables.
No usar `railway.internal`: Vercel necesita el dominio público HTTPS. El secreto
y la identidad firmada protegen la API entre ambos servicios. No conectar previews
de Vercel a la base/worker de producción.

## Webhooks y dominio

- Telnyx: configurar el webhook v2 como
  `https://DOMINIO-RAILWAY/webhooks/telnyx`. El código también envía esa URL al
  marcar y genera `wss://DOMINIO-RAILWAY/media/…` desde `PUBLIC_BASE_URL`.
- Stripe: configurar un endpoint **live** en
  `https://DOMINIO-RAILWAY/webhooks/stripe` con los eventos de [BILLING](BILLING.md).
  Guardar su secreto de firma en Railway. Retirar el antiguo destino ngrok cuando
  el nuevo esté verificado. Los endpoints están en el worker, no en `/api` de Vercel.
- Opcional: añadir `voice.tomoshimoshi.com` en Custom Domain de Railway y copiar
  los registros DNS exactos que indique. Esperar a que TLS esté listo; actualizar
  ambas URL de entorno y los webhooks durante mantenimiento. El dominio raíz
  de la web sigue apuntando a Vercel.

## Actualizaciones: detener antes de sustituir

**Este worker no admite rolling deployments.** Railway arranca la versión nueva
antes de detener la anterior; la nueva no puede adquirir el bloqueo de PostgreSQL
y falla. `overlapSeconds=0` no elimina ese solapamiento de arranque. No quitar el
bloqueo ni declarar saludable un worker que no lo posee.

Para cambios de código, variables o rollback:

1. Reservar una ventana de mantenimiento sin llamadas ni nuevas solicitudes.
2. Detener el despliegue activo de voz y esperar a su apagado completo.
   En el menú del despliegue, `Remove` lo detiene y lo mueve al historial;
   después se puede volver a desplegar. No borrar el servicio ni la base de datos.
3. Desplegar la nueva revisión/configuración con una única réplica.
4. Comprobar `/healthz` y el acceso desde la web. Hay una interrupción breve de la
   API durante la sustitución. Un reinicio con llamadas activas las interrumpe.

`Restart` reinicia el contenedor con su configuración original: no aplica
variables guardadas después de crear ese despliegue. Puede usarse para reiniciar
la misma revisión sin cambios, siempre que no haya llamadas activas.

Si aparece `A voice worker already owns this database`, localizar el proceso
anterior (Railway o local) y detenerlo correctamente. No forzar recuperación
mientras otro worker está activo. Un entorno de prueba necesita una base y
credenciales separadas.

## Comprobación después del despliegue

1. `/healthz` responde 200; `/state` sin credenciales responde 401.
2. Iniciar sesión en la web y comprobar perfil, contactos, historial y saldo.
   Las peticiones autenticadas al proxy ya no deben devolver 503.
3. Verificar Checkout live y la firma del webhook. La aceptación con dinero real requiere una compra controlada por el titular; nunca usar tarjetas de prueba en live.
4. Con telefonía habilitada y un número de prueba autorizado, comprobar una
   llamada corta: audio en ambos sentidos, transcripción, respuesta desde la web
   y cancelación. Revisar el resultado guardado y que el proveedor haya colgado.

Las pruebas locales usan datos aislados y no hacen llamadas. La verificación real
de audio requiere una llamada controlada después del despliegue.

Referencias: [configuración de Railway](https://docs.railway.com/infrastructure-as-code),
[ciclo de sustitución](https://docs.railway.com/deployments/deployment-teardown),
[WebSockets y límites](https://docs.railway.com/networking/public-networking/specs-and-limits).
