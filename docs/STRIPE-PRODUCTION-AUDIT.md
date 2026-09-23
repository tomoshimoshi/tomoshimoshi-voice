# Stripe: revisión de producción

Fecha: 2026-09-23 (Asia/Tokyo).

**Estado: backend y web desplegados en producción; Checkout live y recepción de un webhook real verificados. Falta completar una compra real del titular para verificar el abono tras el cobro. No se ha cobrado dinero en esta revisión.**

## Verificado en Stripe y Railway

- Cuenta ToMoshiMoshi: `charges_enabled=true`, `payouts_enabled=true`, tarjetas activas y sin requisitos vencidos o pendientes.
- Tres Prices live activos, pago único, JPY, coincidentes con la configuración local: ¥1.000 (`price_1UISK9D0IscjIJlKirDaS7T9`), ¥2.000 (`price_1UISKeD0IscjIJlKEed546EH`) y ¥5.000 (`price_1UISLKD0IscjIJlKQSGtrvYp`). No se duplicaron productos ni precios.
- La clave restringida live existente puede leer Prices. Tras guardar el titular los permisos, se verificó mediante llamadas de solo lectura el acceso a Checkout Sessions, PaymentIntents, Refunds y Disputes. Los errores iniciales **403 `more_permissions_required`** de Refunds y Disputes están resueltos. En la revisión inicial las listas de Checkout Sessions y PaymentIntents live estaban vacías.
- Webhook live `we_1UISDeD0IscjIJlKdeEjIOo6`, API `2026-08-26.dahlia`, habilitado: se corrigió la URL a `https://voice-production-53b8.up.railway.app/webhooks/stripe` con los 13 eventos de BILLING.md. Se conservó el endpoint y su secreto.
- El titular añadió `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` a Railway. Desde el nuevo contenedor, `npm run check:billing` verificó los tres precios live, permisos, esquema e inexistencia de saldos de otro modo. Se usa el modo live predeterminado de `NODE_ENV=production`.
- Railway: despliegue activo `d1ae796a-1d23-42db-98f1-f4dab936f5f5`, revisión `2621975`. Se desactivaron despliegues automáticos y se detuvo la instancia anterior con autorización del titular, sin llamadas activas, antes del nuevo arranque. Una sola réplica. `/healthz`: 200; `/state` sin credenciales: 401; webhook sin firma: 400.
- Neon: base `neondb`, rama `br-plain-rain-azmgcul4`, identidad contrastada con el contenedor Railway. Migración 004 probada en `stripe-live-migration-check` y aplicada con el ejecutor versionado en producción. Copia de recuperación `snap-delicate-credit-azay80vv`. La rama de comprobación quedó con compute inactivo. Antes de migrar había cero pagos y cero monederos con saldo.
- Web: revisión `9c31569` publicada. `/commerce?lang=es` responde 200 con política de reembolsos; dashboard, saldo, paquetes y enlaces legales verificados en navegador autenticado.
- Checkout creado desde la web: sesión live por JPY 1.000, importe y aviso de no devolución visibles. Se abandonó y expiró sin pagar. El evento Stripe `evt_1UIejpD0IscjIJlKwugTyGYy` (`checkout.session.expired`) quedó registrado en `billing_provider_events` y el pago quedó `expired`, `livemode=true`. Esto verifica entrega y firma reales, sin simular eventos ni acreditar dinero.
- La cuenta Railway mostraba **Limited Trial**, 30 días o USD 4,98 restantes. Revisar el plan para continuidad del servicio; no se contrató ni modificó ningún plan.

## Correcciones publicadas

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

## Aceptación pendiente

El titular debe completar una compra real controlada para verificar autorización y entrega única de crédito. Los tres precios están verificados por API y los tres paquetes por pruebas aisladas; se abrió Checkout real de ¥1.000. No usar tarjetas de prueba en live. Una prueba local o un evento de expiración no certifican un cobro completado. Tras la compra, comprobar el pago `succeeded`, un único movimiento de abono y el saldo correcto; revisar también el retorno y la conciliación.

Revisar el plan Railway para continuidad: sigue en Trial. No se contrató ningún plan. No se procesaron reembolsos ni disputas reales; sus movimientos contables se verificaron con pruebas aisladas.

La entrada de credenciales y cualquier pago por navegador los realiza el titular. No se guardaron secretos en Git. Una solicitud de suspensión Neon con identificador vacío fue bloqueada automáticamente y no modificó la base; producción permaneció activa.

Fuentes: [Stripe go-live](https://docs.stripe.com/get-started/checklist/go-live), [reembolsos de Stripe](https://docs.stripe.com/refunds), [información de venta a distancia de la Agencia de Asuntos del Consumidor de Japón](https://www.no-trouble.caa.go.jp/what/mailorder/). El tratamiento fiscal y cualquier obligación regulatoria del saldo prepago requieren validación específica del negocio; actualizar los textos no constituye una certificación jurídica.
