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

Stripe está limitado a modo de prueba. Configuración de telefonía válida y healthcheck correcto no verifican recargas, saldo ni calidad de audio. Las pruebas automatizadas no hacen llamadas reales.

`lib/` conserva copias de los modelos y la identidad compartidos con la web; no hay un paquete compartido ni sincronización automática. Coordinar los cambios de contrato y el catálogo público como se indica en [desarrollo](docs/DEVELOPMENT.md).

El servicio se extrajo del repositorio web en la revisión `5d4ff2a`; el primer commit independiente es `35e330b`. Esa extracción conservó sin cambios el código del worker, los scripts y las migraciones.
