# Assessment de Voice · 23 de septiembre de 2026

La evaluación integral, incluida la interfaz y el reparto de responsabilidades, se mantiene en [ToMoshiMoshi Web](https://github.com/tomoshimoshi/tomoshimoshi/blob/main/docs/ASSESSMENT-2026-09-23.md). Este documento resume lo que cambia en el servicio y cómo verificarlo.

## Resultado

El backend ya separa datos por `sub`/usuario, verifica la identidad HMAC, usa SQL parametrizado y transacciones para crédito, valida firmas de proveedores y conserva el bloqueo PostgreSQL de worker único. La revisión encontró y corrigió fallos de aislamiento de errores, límites de recursos y empaquetado. No se modificaron migraciones aplicadas ni se desplegó el servicio.

| Hallazgo | Arreglo |
| --- | --- |
| Excepciones de audio Realtime malformado podían escapar del callback y afectar al worker compartido. | Captura de errores de todo el manejador, validación de envoltorio y control ID; cierre solo de la llamada afectada. |
| El buffer previo a OpenAI limitaba 250 frames pero no bytes. | Máximo conjunto de 250 frames y 1 MiB; cierre con `AUDIO_BACKPRESSURE`. |
| Las API y operaciones Stripe podían consumirse repetidamente por una cuenta autenticada. | Límite en memoria de 180 solicitudes/minuto y 20 consultas de pago/minuto por identidad; responder/cancelar dispone de una cuota independiente de 60/minuto; capacidad acotada a 10.000 identidades. Cuota persistente de 10 claves nuevas de Checkout/30 min bajo lock del usuario, conservando reintentos. |
| UUID de recurso malformado podía acabar en error SQL y 500. | Validación antes de acceso a datos; 400 `INVALID_INPUT`. Callbacks con client_state no UUID no consultan llamadas ajenas a ese formato. |
| `.dockerignore` excluía `scripts/check-billing.ts`, requerido por Dockerfile. | Inclusión explícita en el contexto de build. |
| README decía “Stripe solo test”. | Documentación de test/live, separación de bases y responsabilidades actualizada. |

## Evidencia y pruebas

`npm run check` ejecuta lint, TypeScript y pruebas aisladas, incluyendo PostgreSQL WASM (PGlite), HTTP en puerto temporal, sesiones y proveedores simulados. Se añadieron regresiones para audio inválido, tamaño de cola, cuota con expiración/capacidad, Checkout con reintentos en el límite y UUID HTTP inválido. Resultado: **84 tests**, lint y TypeScript correctos. Se ejecutaron además **4 tests de concurrencia nativa** con PostgreSQL 18.4 temporal en loopback: sobregiro, cuota Checkout con 20 intentos simultáneos, abono único y liquidación única.

`npm audit --json`: cero avisos conocidos, incluyendo dependencias de desarrollo. Desde Web, `npm run check:contracts -- ../tomoshimoshi-voice` confirmó igualdad de los siete helpers compartidos y del catálogo. Una búsqueda orientativa del snapshot versionado no encontró claves privadas/live ni `.env` privado versionado; no equivale a escaneo completo del historial Git.

Se leyó producción sin autenticación: `/healthz` devolvió 200, `/state` devolvió 401. Eso comprueba la frontera del despliegue existente; los arreglos locales aún necesitan publicarse. No hubo llamadas, cobros, cambios de saldo, migraciones ni consultas a datos privados de producción.

No se ejecutó un build Docker (herramienta ausente), restauración de backup o aceptación telefónica real. La prueba nativa local usa PostgreSQL 18.4; CI mantiene PostgreSQL 17. La suite local pasó con Node 25.6.0; CI y la imagen declaran Node 24.

## Riesgos y tareas operativas pendientes

- Un único proceso conserva sockets/timers. Mantener una réplica por base; planificar despliegue sin llamadas activas y detener el worker anterior. Falta medir capacidad y definir un máximo global de llamadas.
- Los limitadores en memoria se reinician con el proceso; la cuota de creación de Checkout permanece en PostgreSQL. No sustituyen protección de tráfico público en Railway/Auth0 ni límites comerciales de los proveedores.
- Redactar el token query de `/media/:id?token=…` en logs del hosting. Rotar el secreto compartido de forma coordinada y mantener secretos de proveedores exclusivamente en Voice, idealmente con permisos restringidos.
- La identidad firmada confía en la web. No hay RLS PostgreSQL: una ruta nueva debe probar aislamiento por propietario. No usar la variante de `getCall` sin propietario en operaciones de usuario.
- `shareProfile=false` evita incluir el perfil en instrucciones; transcripción y brief siguen siendo datos personales. Definir retención, borrado/anonimización y backups sin destruir historial financiero. `store:false` en traducción no certifica retención de todos los proveedores.
- Conciliación sin evidencia conserva reservas; falta alerta/atención operativa para pendientes. El I/O Stripe de reversos dentro de transacción debe medirse para evitar retener conexiones bajo carga.
- Probar recuperación, llamadas EN/ES/JA, prompt injection, ruido e interrupciones; verificar un pago controlado y su abono real antes de afirmar aceptación completa.

Antes de publicar: `npm run check`, `npm run test:billing:postgres` con base desechable y build Docker en CI. Luego seguir [Railway](RAILWAY.md), [operaciones](OPERATIONS.md) y [facturación](BILLING.md). Una compilación correcta y `/healthz` no prueban ni calidad de audio ni liquidación real de dinero.
