# Configuración

Las instrucciones del antiguo proceso combinado web/voz se han sustituido por estas guías:

- [Desarrollo local con los dos repositorios](DEVELOPMENT.md).
- [Variables, proveedores, callbacks y despliegue en Railway](RAILWAY.md).
- [PostgreSQL y migraciones](POSTGRESQL.md).
- [Stripe: producción y entorno de pruebas](BILLING.md).
- [Operación y diagnóstico](OPERATIONS.md).

Auth0 y la configuración de Next.js pertenecen al [repositorio web](https://github.com/tomoshimoshi/tomoshimoshi). Las credenciales Telnyx/OpenAI/Stripe y PostgreSQL pertenecen al servidor de voz. El mismo `CALLORI_INTERNAL_TOKEN` explícito se configura en ambos.
