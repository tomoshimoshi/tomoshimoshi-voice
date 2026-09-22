# Operación del servidor de voz

Guía del servicio separado en Railway. La configuración detallada está en [RAILWAY](RAILWAY.md), el contrato en [API](API.md) y las decisiones en [arquitectura](ARCHITECTURE.md).

## Ubicación y proceso

| Elemento | Ubicación |
| --- | --- |
| Web | `https://www.tomoshimoshi.com` · Vercel |
| Voz | `https://voice-production-53b8.up.railway.app` · Railway, servicio `voice` |
| Código de voz | `tomoshimoshi/tomoshimoshi-voice`, rama `main` |
| Datos | PostgreSQL en Neon; no dependen del disco efímero del contenedor |

Mantener una réplica, suspensión desactivada y despliegues automáticos desactivados. El Dockerfile fija `VOICE_HOST=0.0.0.0` y utiliza el `PORT` de la plataforma. Los secretos se administran en Railway; la web conserva solo sus credenciales Auth0 y el secreto de comunicación necesario.

## Comprobar salud sin modificar datos

```sh
curl --fail-with-body https://voice-production-53b8.up.railway.app/healthz
```

Esperado: HTTP 200 y `{"status":"ok"}`. La ruta comprueba aceptación de tráfico, salud de persistencia y acceso SQL. No certifica OpenAI, Telnyx, Stripe ni saldo.

Comprobar después el panel con sesión iniciada: perfil, historial y saldo. La API privada sin credenciales debe devolver 401. `readiness` añade controles de telefonía y recuperación; no hacer una llamada real como prueba automática de despliegue.

## Desplegar o volver a una revisión anterior

1. Preparar y verificar código/configuración antes de interrumpir el servicio. Si cambia el esquema, revisar migraciones y respaldo como operación independiente.
2. Reservar mantenimiento sin nuevas solicitudes y confirmar que no hay llamadas activas.
3. Detener el despliegue anterior. En Railway, `Remove` del **despliegue** lo detiene y conserva una entrada en el historial; no borrar el servicio ni los datos.
4. Esperar la terminación y la liberación del bloqueo de PostgreSQL.
5. Desplegar la revisión/configuración elegida con una réplica. Comprobar commit, repositorio y resultado del healthcheck.
6. Verificar el acceso desde la web, la disponibilidad y los logs de arranque.

Existe una interrupción breve de la API. `Restart` conserva las variables del despliegue original: para aplicar variables nuevas se necesita un nuevo despliegue. `overlapSeconds=0` por sí solo no evita que Railway intente arrancar dos workers durante una sustitución.

Un rollback de código no deshace migraciones SQL ni movimientos de saldo. Comprobar compatibilidad antes de volver a una versión anterior. Ver [Railway](RAILWAY.md) para el procedimiento completo.

## Recuperación y diagnóstico

| Síntoma | Comprobar | Acción |
| --- | --- | --- |
| `A voice worker already owns this database` | Worker previo o proceso local conectado a la misma base | Detener el propietario correcto; no eliminar el bloqueo para forzar dos procesos |
| 503 en `/healthz` | Arranque/apagado, conectividad SQL, `call_persistence_failed` | Restaurar conectividad y reiniciar controladamente; no declarar sano al proceso a mano |
| Web sin estado, API privada 401 | Igualdad del token interno; firma/caducidad de identidad | Corregir configuración entre web y voz; no enviar secretos al navegador |
| `INVALID_ORIGIN` en la web | `APP_BASE_URL`, Host y origen exactos | Usar el dominio canónico, incluido `www` cuando corresponda |
| `NOT_CONFIGURED` | Flags, variables de telefonía y origen HTTPS | Revisar `readiness.checks`; presencia no garantiza validez de credenciales |
| `RECOVERY_PENDING` | `provider_calls` pendientes de una llamada terminal | Confirmar el estado del proveedor y permitir recuperación; no borrar registros para habilitar llamadas |
| `BILLING_NOT_CONFIGURED` | Clave de prueba, firma y tres Price IDs | Completar la configuración de [Stripe](BILLING.md) sin quitar la protección de modo test |
| `INSUFFICIENT_CREDIT` | Saldo disponible, reservado y tarifa | Revisar recarga o reserva pendiente; no editar saldos directamente |
| Llamada finalizada con cargo pendiente | Eventos de respuesta/cuelgue y evidencia del proveedor | Ejecutar informe de conciliación y seguir [BILLING](BILLING.md) |

Un cuelgue fallido solo se trata como exitoso si Telnyx confirma que la llamada ya no está activa. El worker conserva el control y reintenta. Tras reiniciar, las conversaciones previas no se reanudan; quedan fallidas y se intenta cerrar cualquier llamada pendiente en el proveedor.

## Logs y conciliación

Los logs registran eventos como `call_persistence_failed`, `hangup_recovery_pending`, `payment.webhook_failed`, `wallet.reserved` y `call.charged`, junto con identificadores de correlación. Para investigar, seguir el ID de llamada o pago entre logs, base y proveedor. No copiar tokens, transcripciones ni cuerpos privados a tickets públicos.

`npm run billing:reconcile` sin argumentos es un informe de solo lectura: detecta discrepancias entre ledger/saldo/reservas, llamadas vencidas para revisión y pagos pendientes. Puede devolver código no cero si hay algo que atender. El conteo de outbox pendiente no significa que exista un consumidor configurado.

La variante con `--call` **modifica la liquidación** y exige evidencia del proveedor; seguir el procedimiento de [facturación](BILLING.md). No programar reparaciones a ciegas ni liberar reservas solo porque ha transcurrido tiempo. Este repositorio no instala un cron de conciliación.

## Backups y datos

Ejecutar desde un entorno protegido con `pg_dump` compatible y conexión directa:

```sh
npm run backup -- /ruta/privada/tomoshimoshi.dump
```

La herramienta evita sobrescrituras y crea el archivo con permisos privados. No incluye secretos `.env`. Verificar `pg_restore --list` y ensayar restauración en una base aislada antes de depender del respaldo. La ventana de recuperación de Neon se configura aparte; el código no cambia su plan.

No editar migraciones ya aplicadas, reimportar SQLite por haber cambiado de repositorio, borrar el ledger ni resetear saldos para resolver incidencias. El historial financiero usa movimientos compensatorios; ver [PostgreSQL](POSTGRESQL.md) y [BILLING](BILLING.md).
