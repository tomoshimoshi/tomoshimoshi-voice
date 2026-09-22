# Stripe: revisión de producción

Fecha: 2026-09-22 (Asia/Tokyo). **Resultado: no listo para cobrar dinero real.**

## Verificado directamente

- Cuenta Stripe ToMoshiMoshi: `charges_enabled=true`, `payouts_enabled=true`, pagos con tarjeta activos y sin requisitos actualmente vencidos/pendientes. No se copiaron datos personales ni bancarios a este informe.
- Tres Prices live activos, de pago único, en JPY: ¥1.000 (`price_1UISK9D0IscjIJlKirDaS7T9`), ¥2.000 (`price_1UISKeD0IscjIJlKEed546EH`) y ¥5.000 (`price_1UISLKD0IscjIJlKQSGtrvYp`). No se crearon productos/precios nuevos.
- Único webhook live listado: `we_1UISDeD0IscjIJlKdeEjIOo6`, habilitado, API `2026-08-26.dahlia`, destino `https://tomoshimoshi.com/api/stripe/webhook`, únicamente `checkout.session.completed`.
- El destino devuelve HTTP 308 hacia `www`; la ruta en `www` exige sesión (401). El código no implementa esa ruta de Stripe en la web.
- `https://voice-production-53b8.up.railway.app/healthz` devuelve 200 y `{"status":"ok"}`.
- Un POST vacío sin firma a `https://voice-production-53b8.up.railway.app/webhooks/stripe` devuelve **503 `BILLING_NOT_CONFIGURED`**. Esto demuestra configuración incompleta/inválida, pero no identifica qué variable falta. No se expusieron secretos ni se generaron pagos.
- `https://voice.tomoshimoshi.com` falla la validación TLS por nombre de certificado. No usar este dominio como webhook mientras no tenga certificado válido. No se omitió la verificación TLS.
- La raíz web redirige correctamente por HTTPS a `https://www.tomoshimoshi.com/`.

## Bloqueos y acciones

1. **P1 — Backend limitado a test.** `server/billing/stripe/config.ts` exige `sk_test_`; el adaptador rechaza Prices/Sessions/PaymentIntents live y `processStripeEvent` rechaza eventos live. Los precios creados en producción no funcionan con esta versión. Antes de habilitar cobros: implementar modo explícito validado, comprobarlo en todos los objetos, probar ambas ramas, configurar claves/precios/secreto del mismo entorno y separar la base de prueba de los saldos reales. No basta con sustituir la clave.
2. **P1 — Webhook live en ruta incorrecta y backend sin configuración válida.** Tras preparar el backend live, usar el endpoint del worker `/webhooks/stripe`, inicialmente con el dominio Railway que sí tiene TLS válido. Suscribir `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`. Guardar en Railway el secreto correspondiente a ese endpoint, no el de `stripe listen`. Verificar entrega 200 y aumento único del saldo ante reintentos. No se modificó todavía el endpoint live porque el receptor aún rechaza modo live.
3. **P1 — Reembolsos/disputas sin tratamiento operativo completo.** El procesamiento actual sólo contempla Checkout. El reembolso interno de uso no es un reembolso de dinero en Stripe. Un reembolso/contracargo en Stripe no revierte ni bloquea automáticamente el saldo comprado; los demás eventos se ignoran. Definir e implementar el procedimiento de saldo, dinero ya gastado, soporte y conciliación antes de lanzar.
4. **P1 — Falta aceptación completa en el entorno desplegado.** Confirmar migraciones, aislamiento test/live, secretos, acceso con Auth0 y recarga hospedada; después verificar pago demorado, fallo, cancelación, eventos repetidos y conciliación. `/healthz` no certifica Stripe. No se hizo ningún cobro real ni llamada telefónica.

## Dominio personalizado descartado

El 2026-09-23 el titular decidió mantener `checkout.stripe.com` para evitar la mensualidad de USD 10. No se contrató la suscripción ni se crearon registros DNS. Se retiraron la variable opcional, el soporte de dominio personalizado y su prueba específica.

Se canceló el formulario de alta en Stripe y se verificó que continúan los dominios predeterminados. Tras retirar el cambio, las 34 pruebas de facturación pasaron y `git diff --check` no detectó problemas.

Se conservan los cambios de la revisión independientes del dominio: métodos de pago configurados en Stripe e identificador estable de integración. Estos cambios siguen **sin desplegar**. La publicación del worker requiere mantenimiento sin llamadas, detener el worker anterior y arrancar una sola instancia, según `RAILWAY.md`.

## Verificación y límites

- Backend (verificación del 2026-09-22, antes de retirar el dominio opcional): `npm run check`, lint/typecheck correctos y **69 pruebas aprobadas**, incluyendo firmas, duplicados, rollback, importes, ledger y rechazo/aceptación de dominios. La primera ejecución en sandbox falló al abrir un puerto local; la ejecución autorizada fuera de esa restricción pasó íntegra. Proveedores simulados y bases aisladas, sin `.env` de producción.
- Web: lint sin errores (5 advertencias existentes), typecheck, **29 pruebas aprobadas** y build de producción correcto.
- `npm audit --omit=dev`: cero vulnerabilidades reportadas en ambos repositorios.
- Las pruebas locales se ejecutaron con Node 25.6; CI/Docker fijan Node 24. No se ejecutaron aquí las pruebas de concurrencia en PostgreSQL nativo; están configuradas en CI. No se leyó ni modificó la base de producción.
- El conector Vercel disponible no expone el proyecto ToMoshiMoshi; no se certificaron variables ni revisión desplegada de Vercel/Railway.
- Revisar soporte público, términos, privacidad, política de reembolsos y tratamiento fiscal antes del lanzamiento. Los Prices muestran `tax_behavior=unspecified` y el Checkout no activa impuestos automáticos. No se activó Stripe Tax ni se asumió una obligación tributaria concreta.

Referencias: [cumplimiento de Checkout](https://docs.stripe.com/checkout/fulfillment), [webhooks](https://docs.stripe.com/webhooks), [dominios personalizados](https://docs.stripe.com/payments/checkout/custom-domains), [precio del dominio](https://support.stripe.com/questions/custom-domain-on-stripe-hosted-surfaces-faq).
