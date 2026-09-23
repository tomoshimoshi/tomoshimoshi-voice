# Stripe: revisión de producción

Fecha: 2026-09-23 (Asia/Tokyo).

**Estado: implementación local preparada y probada; permisos de lectura verificados. Activación en producción pendiente de secretos y despliegue. No se ha realizado ningún cobro real.**

## Verificado en Stripe y Railway

- Cuenta ToMoshiMoshi: `charges_enabled=true`, `payouts_enabled=true`, tarjetas activas y sin requisitos vencidos o pendientes.
- Tres Prices live activos, pago único, JPY, coincidentes con la configuración local: ¥1.000 (`price_1UISK9D0IscjIJlKirDaS7T9`), ¥2.000 (`price_1UISKeD0IscjIJlKEed546EH`) y ¥5.000 (`price_1UISLKD0IscjIJlKQSGtrvYp`). No se duplicaron productos ni precios.
- La clave restringida live existente puede leer Prices. Tras guardar el titular los permisos, se verificó mediante llamadas de solo lectura el acceso a Checkout Sessions, PaymentIntents, Refunds y Disputes. Los errores iniciales **403 `more_permissions_required`** de Refunds y Disputes están resueltos. En la revisión inicial las listas de Checkout Sessions y PaymentIntents live estaban vacías.
- Webhook live `we_1UISDeD0IscjIJlKdeEjIOo6`, API `2026-08-26.dahlia`, habilitado, sigue apuntando a `https://tomoshimoshi.com/api/stripe/webhook`, con solo `checkout.session.completed`. Esa ruta no está implementada en la web. No se cambió el receptor antes de preparar su configuración y despliegue.
- Railway, proyecto `tomoshimoshi`, servicio `voice`, entorno `production`: hay variables de los tres precios, pero no `STRIPE_SECRET_KEY` ni `STRIPE_WEBHOOK_SECRET` en la lista de variables del servicio. La revisión activa observada es anterior a estos cambios.
- La cuenta Railway mostraba **Limited Trial**, 30 días o USD 4,98 restantes. Revisar el plan para continuidad del servicio; no se contrató ni modificó ningún plan.

## Corregido en el código local

- Soporte explícito `STRIPE_MODE=live|test`, claves secretas o restringidas del mismo modo. En NODE_ENV=production el valor por defecto es live. Live exige HTTPS.
- Validación de modo en Price, Checkout Session, PaymentIntent, Price de la línea, webhook y pago interno. Migración `004_live_payments.sql`: modo inmutable de pagos históricos y proyección de reversiones. Los pagos anteriores conservan modo test.
- Confirmación independiente en Stripe, importes JPY exactos, cantidades, metadatos de titular/compra/paquete, firmas sobre el cuerpo original e idempotencia transaccional.
- Recuperación de pagos pendientes desde la página de retorno y por conciliación cada minuto. La URL de retorno nunca es evidencia de pago. Conciliación periódica también de compras liquidadas para recuperar devoluciones/disputas cuyo webhook falte.
- Devoluciones y disputas ajustan el saldo con movimientos contables compensatorios. Los eventos repetidos no duplican la deducción. Reembolsos fallidos o disputas ganadas restauran únicamente el saldo retirado. El saldo reservado no se toca; un faltante bloquea nuevas llamadas y compras y requiere revisión. No se realizan cobros ni devoluciones de dinero automáticamente.
- Checkout alojado en `checkout.stripe.com`, JPY sin conversión adaptativa, información de compra y enlaces legales. No se contrató dominio personalizado ni se habilitó Stripe Tax.
- Privacidad, condiciones y aviso comercial (`/commerce`) en español, inglés y japonés. Política aprobada por el titular: sin devoluciones voluntarias, salvo errores de cobro y derechos legales. Enlaces disponibles antes del pago y en los pies de página.

## Verificación local

- Node **24.21.0**, la familia de runtime usada en producción.
- Backend: `npm run check`, **78 pruebas aprobadas**, lint y TypeScript correctos. Incluye duplicados, rollback, modos live/test, reversiones parciales, disputa ganada, saldo reservado, recuperación de webhooks y aislamiento por titular.
- Web: `npm run check`, **36 pruebas aprobadas**, TypeScript y build de producción correctos; cinco advertencias de lint preexistentes, sin errores.
- Vista compilada local: aviso comercial y condiciones accesibles sin login, contenido y navegación verificados en navegador.
- Las pruebas usan PGlite aislado y transportes Stripe simulados; no cargan secretos de producción ni hacen llamadas reales. Concurrencia PostgreSQL nativa sigue disponible en CI; no equivale a la simulación serial del helper local.

## Pasos de activación pendientes

1. El titular debe configurar `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` en Railway; el segundo debe pertenecer al endpoint live indicado. No compartir secretos por chat ni guardarlos en Git. Fijar `STRIPE_MODE=live`.
2. Mantener los permisos de la clave restringida según BILLING.md: Checkout Sessions escritura/lectura; Prices, PaymentIntents, Charges, Refunds y Disputes lectura. El titular guardó los permisos y se verificaron las lecturas de Checkout Sessions, PaymentIntents, Refunds y Disputes; la escritura de Checkout no se ha verificado creando una sesión real.
3. En mantenimiento sin llamadas ni nuevas solicitudes, confirmar base y copia de seguridad; aplicar migración 004 y ejecutar `npm run check:billing`. Revisar cualquier saldo financiado con test antes de usar la misma base en live, sin borrar historial.
4. Publicar el backend conforme a RAILWAY.md: detener primero la instancia anterior y arrancar una sola instancia con la nueva revisión/configuración. Publicar la web con sus textos y enlaces.
5. Cambiar el webhook live a `https://voice-production-53b8.up.railway.app/webhooks/stripe` y suscribir los 13 eventos documentados en BILLING.md. Conservar el secreto del endpoint. Comprobar que la firma se acepta y la entrega responde 200.
6. Abrir los tres paquetes desde la web autenticada y comprobar importes. El titular debe completar una compra real controlada para verificar autorización, entrega única de crédito y conciliación. No usar tarjetas de prueba en live. Una prueba local, `/healthz` o una cuenta Stripe habilitada no certifican ese recorrido.

La entrada de credenciales por navegador requiere intervención del titular según las reglas de la herramienta. El titular modificó los permisos de la clave existente. El agente no ha modificado claves, saldos ni despliegues de producción en esta revisión.

Fuentes: [Stripe go-live](https://docs.stripe.com/get-started/checklist/go-live), [reembolsos de Stripe](https://docs.stripe.com/refunds), [información de venta a distancia de la Agencia de Asuntos del Consumidor de Japón](https://www.no-trouble.caa.go.jp/what/mailorder/). El tratamiento fiscal y cualquier obligación regulatoria del saldo prepago requieren validación específica del negocio; actualizar los textos no constituye una certificación jurídica.
