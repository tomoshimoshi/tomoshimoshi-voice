# PostgreSQL, identidad y registro

Actualizado: 22 de septiembre de 2026.

## Configuración

- `DATABASE_URL`: conexión directa Neon; migraciones, importación, backups y bloqueo exclusivo del worker de voz.
- `DATABASE_URL_POOLED`: conexión PgBouncer para consultas habituales (pool de hasta 5 conexiones por proceso). Si falta, se usa la directa.
- `NEON_AUTH_BASE_URL`: no se usa. Auth0 es el único proveedor de identidad.
- `APP_BASE_URL`: origen exacto de la aplicación, HTTPS en producción. Configurarlo también en las URL de callback/logout de Auth0.
- `CALLORI_INTERNAL_TOKEN`: secreto aleatorio compartido de al menos 32 caracteres, obligatorio en producción. El valor local autogenerado solo se permite en desarrollo.
- `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET`: se conservan. No hay contraseñas en PostgreSQL.

El tráfico PostgreSQL remoto verifica el certificado TLS. Las consultas usan parámetros, tiempos de espera y conexiones limitadas. Los valores secretos no se imprimen ni se publican en el navegador.

## Migración

```sh
npm run db:migrate
npm run db:import-sqlite
```

Los SQL completos están en `db/migrations`. El ejecutor usa transacciones, bloqueo de migración y checksums; repetirlo no vuelve a crear tablas. No editar migraciones aplicadas: añadir otra.

La importación es explícita, transaccional y de una sola ejecución. Requiere terminar las llamadas y resolver controles pendientes. Lee SQLite sin modificarlo, copia el perfil, llamadas y contactos y reserva su propiedad para `leodcastaneda@gmail.com`. Un correo no verificado no recibe esos datos. La reserva se vincula al primer sujeto Auth0 con ese correo verificado; otras identidades con el mismo correo no se fusionan. Si esa misma cuenta entró antes de verificar el correo, se vinculan los datos al verificarlo. Los consentimientos históricos no se fabrican: solo las nuevas llamadas tienen el registro de consentimiento fechado.

Detener el servidor SQLite antes de importar. No volver a arrancar una versión SQLite después de migrar, porque crearía dos historiales divergentes. El original es una copia de recuperación, no un respaldo de las escrituras posteriores en PostgreSQL.

## Tablas e índices

`users` identifica cada cuenta por `auth0_sub` único. `profiles`, `calls`, `contacts`, `requests` y `call_consents` pertenecen a un usuario. `provider_calls` y `webhooks` son registros internos de operación. `schema_migrations` y `data_imports` controlan despliegues/importaciones.

Los índices cubren historial `(user_id, created_at DESC, id DESC)`, búsqueda de correo, contactos por usuario y fecha, webhooks por antigüedad y llamadas activas. Un índice parcial único permite una sola llamada activa por usuario. Las claves foráneas compuestas impiden asociar solicitudes o consentimientos a llamadas de otra cuenta. Los campos variables y transcripciones usan JSONB; identidad, propiedad, estado y fechas están en columnas indexadas.

El historial carga 50 registros sin transcripciones y ofrece paginación por fecha e ID. La transcripción se obtiene solo al abrir su llamada. La lista se actualiza cada 5 segundos, la llamada activa cada 1,2 segundos y las pestañas ocultas con menos frecuencia. La búsqueda/totales del historial corresponden a los registros cargados.

## Identidad, seguridad y consentimiento

El registro usa [Auth0 Universal Login](https://auth0.com/docs/authenticate/login/auth0-universal-login/universal-login-vs-classic-login/universal-experience) con `screen_hint=signup`, correo y contraseña. Habilitar una conexión de base de datos en Auth0; no exigir campos personales en su pantalla de registro. Auth0 controla contraseñas, recuperación y verificación del correo. El usuario puede explorar antes de verificarlo; necesita correo verificado para llamar. Tras verificar el enlace debe volver a iniciar sesión para actualizar el claim en la sesión.

Cada petición Next.js comprueba la sesión y firma una identidad con caducidad de 30 segundos para el servidor de voz. Este exige tanto el secreto interno como la identidad firmada. Ignora identidades enviadas por el navegador. Las consultas HTTP de llamadas, respuestas y cancelaciones comprueban al propietario y devuelven 404 ante una llamada ajena. Mutaciones web requieren el origen exacto configurado y JSON, además de límites de tamaño. La API de perfil no acepta correo, ID de usuario ni contraseñas.

Nombre y apellidos completan el registro antes de llamar. Edad, sexo, nacionalidad y nombre preferido son opcionales. El modal puede cerrarse, conserva el borrador y no inicia llamadas al guardar. El servidor vuelve a exigir perfil completo; el navegador no es el límite de seguridad.

Compartir el perfil está desmarcado por defecto. La decisión se registra de forma independiente con fecha y versión por cada llamada. Sin ese permiso el perfil se excluye del mensaje enviado al asistente. El objetivo/contexto y las respuestas que el usuario escriba sí se envían para realizar la llamada: no incluir información privada allí si no se desea utilizarla. El texto de consentimiento se refiere a los campos guardados en el perfil.

La reserva de llamada, idempotencia, límite por usuario (30 segundos entre intentos), permiso y llamada se confirman en una sola transacción antes de marcar al proveedor. Los controles del proveedor permiten recuperar llamadas tras fallos. Los webhooks autenticados se deduplican y expiran al día; un fallo de procesamiento permite reintentarlos.

## Operación y límites

Para separar la web en Vercel y el worker de voz en Railway, seguir
[configuración y procedimiento de despliegue](RAILWAY.md).

Un solo worker de voz por base de datos, protegido por un advisory lock en una conexión directa; pueden llamar varios usuarios simultáneamente. El proceso mantiene sockets y estado activo en memoria y serializa sus escrituras a PostgreSQL. No ejecutar el worker detrás de un balanceador sin afinidad y coordinación adicionales. Next.js y voz se comunican por loopback o red privada; si se separan hosts, usar TLS y una política de red apropiada. Neon no sustituye el alojamiento del servidor de voz.

Ante un fallo de persistencia, el servicio deja de aceptar nuevas llamadas, cierra audio, intenta colgar y deja registros durables para recuperación. `/healthz` devuelve 503. Un supervisor debe reiniciarlo tras recuperar la conectividad. El límite de duración en Telnyx cubre la pérdida simultánea de la respuesta de marcado y los callbacks.

El worker está desplegado en Railway; la documentación no acredita una prueba de carga. Para operar públicamente configurar presupuesto/cuotas de proveedor, monitorización, política de retención, recuperación de backups y protección antiabuso de Auth0. La separación por usuario se aplica en el backend; no se afirma usar Row Level Security. Las credenciales PostgreSQL son solo del servidor y deben restringirse a esta aplicación. La cuenta de migraciones necesita DDL; usar un rol distinto con DML mínimo para `DATABASE_URL_POOLED` en producción.

## Backups

`npm run backup -- /ruta/privada/tomoshimoshi.dump` usa `pg_dump` (instalar herramientas cliente compatibles con la versión de PostgreSQL), conexión directa, formato custom y fichero 0600 sin sobrescribir. No incluye `.env`. Validar con `pg_restore --list` y una restauración a una base aislada. Configurar además la ventana de recuperación/restauración de Neon y comprobarla en su consola; este cambio no modifica el plan ni programa backups.

`node scripts/backup-sqlite.mjs /ruta/privada/legacy.sqlite` conserva la herramienta para respaldar exclusivamente el archivo previo a la migración.

## Verificación

Las pruebas usan PostgreSQL real embebido en PGlite, sin credenciales locales. Cubren separación de usuarios, reserva concurrente, consentimiento, límites, migraciones, vinculación de correo verificado e identidad firmada. `npm run test:integration` prueba HTTP con identidades sintéticas y proveedores deshabilitados. La compilación y las pruebas no realizan llamadas reales.

Referencias: [conexiones Neon](https://neon.com/docs/connect/connection-pooling), [TLS de node-postgres](https://node-postgres.com/features/ssl), [Auth0 y verificación de correo](https://auth0.com/docs/manage-users/user-accounts/verify-emails).

### Resultado histórico de la migración inicial

- Neon: un propietario reservado, un perfil y seis llamadas importadas. Se compararon los objetos completos con SQLite y coinciden. Todos los índices están válidos. La conexión del cliente está cifrada con TLS y valida el certificado; Neon termina TLS en su proxy (la vista interna `pg_stat_ssl` del motor no refleja ese tramo).
- `npm run check`: 49 pruebas aprobadas, TypeScript y compilación de producción correctos.
- `npm audit --omit=dev --audit-level=high`: 0 vulnerabilidades reportadas al ejecutar la revisión.
- Navegador: registro en inglés/español, enlace a Auth0 con campos correo/contraseña, modal de perfil en escritorio y móvil, campos obligatorios, opción de posponer, conservación del borrador y ninguna llamada automática al guardar. Se usó un entorno UI temporal con datos ficticios y sin proveedores ni acceso a Neon.
- Servidor local con PostgreSQL: `/healthz` responde `ok`.
- Límites de la comprobación: no se registraron nuevas cuentas reales, no se probaron contraseñas del usuario, no se realizaron llamadas reales, no hubo despliegue público ni prueba de carga. `pg_dump` no está instalado en esta máquina: el respaldo PostgreSQL y la restauración deben comprobarse con herramientas cliente compatibles antes de depender de ellos.

## Prepaid billing

See [Billing architecture, Stripe test setup, manual tests and reconciliation](BILLING.md). Apply migration `003_billing.sql` before running this version. Credits never expire; the current Japan rate is ¥125/minute.
