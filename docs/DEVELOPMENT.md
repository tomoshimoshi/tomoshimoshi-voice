# Desarrollo y mantenimiento de los dos repositorios

## Preparación

Usar Node 24 según `.nvmrc` y una base PostgreSQL de desarrollo. Cada repositorio instala sus dependencias con su propio `package-lock.json`; no necesita enlaces a carpetas del otro.

En `tomoshimoshi-voice`:

```sh
nvm use
npm ci
cp .env.example .env  # solo si todavía no existe
```

Completar `DATABASE_URL` (directa), opcionalmente `DATABASE_URL_POOLED` a la misma base, `APP_BASE_URL=http://localhost:3000` y un `CALLORI_INTERNAL_TOKEN` explícito de al menos 32 caracteres sin espacios. Mantener `LIVE_CALLS_ENABLED=false` durante desarrollo ordinario.

En `tomoshimoshi`, instalar dependencias y configurar Auth0, el mismo `APP_BASE_URL`, el mismo token interno y `VOICE_SERVER_URL=http://127.0.0.1:3001`. El worker no necesita secretos de Auth0; la web no necesita claves de Telnyx, OpenAI, Stripe ni conexión a PostgreSQL.

No confiar en los tokens generados localmente por omisión: con carpetas separadas se generarían valores distintos. No sobrescribir archivos `.env` existentes ni utilizar la base de Railway para un segundo worker local.

## Arranque

Primero, en voz, aplicar migraciones **a la base de desarrollo** y arrancar:

```sh
npm run db:migrate
npm run dev
```

En otra terminal, desde la web:

```sh
npm run dev
```

Abrir `http://localhost:3000`. Para una vista de desarrollo sin login, `AUTH0_ENABLED=false` se configura en la web y solo se respeta en desarrollo. Ese usuario local no tiene correo verificado y no puede marcar llamadas reales.

El panel, perfil e historial requieren el worker y la base, pero no credenciales de telefonía. Para una prueba de voz, configurar proveedores, un destinatario expresamente autorizado y un callback público HTTPS. Un túnel local es solo para esa prueba; producción usa el dominio de Railway.

## Estructura y comandos

```text
tomoshimoshi-voice/
├── server/          HTTP, motor de voz, proveedores y dominio financiero
├── lib/             Tipos, validación e identidad compartidos con la web
├── db/migrations/   SQL incremental; no modificar migraciones aplicadas
├── scripts/         Migración, importación heredada, backup y conciliación
├── tests/           Pruebas aisladas; no utilizan los proveedores reales
├── docs/            Proyecto, arquitectura, API y operación
└── Dockerfile       Imagen de ejecución del worker
```

| Objetivo | Voz | Web |
| --- | --- | --- |
| Desarrollo | `npm run dev` | `npm run dev` |
| Ejecutar versión preparada | `npm start` | `npm run build` y `npm start` |
| Comprobación habitual | `npm run check` | `npm run check` |
| Solo pruebas | `npm test` | `npm test` |
| HTTP del worker | `npm run test:integration` | Pruebas del proxy incluidas en `npm test` |
| Migración | `npm run db:migrate` | No corresponde |
| Conciliación de solo lectura | `npm run billing:reconcile` | No corresponde |

La imagen de voz ejecuta TypeScript mediante `tsx`; este repositorio no tiene un comando `build` ni necesita compilar Next.js. `npm run check` ejecuta lint, tipos y pruebas. En la web añade también la compilación de producción.

## Qué prueban los tests

- `engine`, `providers`, `security`, `http`, `listener`: audio simulado, preguntas, cancelación, recuperación, firmas y fronteras HTTP.
- `postgres`, `contacts`: migraciones, identidad, propiedad y persistencia mediante PGlite aislado.
- `billing`: crédito, reservas, liquidación, rollback y eventos duplicados/desordenados con proveedores simulados.
- `call-plan`, `phone`: compatibilidad de los datos y destinos.
- `backup`: herramienta de respaldo SQLite heredada; no sustituye una prueba de restauración PostgreSQL.

Los tests normales no cargan `.env` ni hacen llamadas. CI usa Node 24 y además levanta PostgreSQL 17 desechable para `test:billing:postgres`, que comprueba concurrencia nativa. Para ejecutarlo localmente, seguir [BILLING](BILLING.md): exige una base loopback llamada `tomoshimoshi_billing_test` y crea un esquema temporal propio.

Una suite verde no verifica credenciales reales, recepción del audio, calidad de voz ni Checkout alojado. Esas comprobaciones requieren pruebas de aceptación controladas.

## Cambios que afectan a ambos repositorios

Coordinar cambios a `lib/types.ts`, `validation.ts`, `phone.ts`, `call-plan.ts`, `profile.ts`, `internal-identity.ts` e `internal-token.ts`. Son copias, no un paquete sincronizado. La web también mantiene `lib/credit-packages.ts` como catálogo público; la autoridad financiera permanece en el backend.

1. Definir el cambio de contrato y documentarlo en [API](API.md).
2. Mantener compatibilidad con la versión de la web que ya está desplegada; preferir adiciones opcionales antes de retirar campos.
3. Actualizar las copias y las pruebas que consumen esos campos en ambos repositorios.
4. Ejecutar los checks correspondientes y revisar los dos cambios conjuntamente.
5. Para romper compatibilidad, diseñar una migración/versionado explícitos antes del despliegue.

La API aún no usa un prefijo de versión. Publicar código no debe reiniciar automáticamente un worker con llamadas activas. Seguir [Railway](RAILWAY.md) para aplicar cambios en producción.
