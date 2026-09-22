# Documentación de ToMoshiMoshi Voice

La documentación describe el servicio separado de la web, según el código revisado el 22 de septiembre de 2026. Comenzar por [el proyecto](PROJECT.md) y continuar con [arquitectura](ARCHITECTURE.md).

| Guía | Qué explica |
| --- | --- |
| [Proyecto](PROJECT.md) | Producto, recorrido del usuario, responsabilidades y límites |
| [Arquitectura](ARCHITECTURE.md) | Topología, secuencia de llamada, estados, audio, datos, seguridad y recuperación |
| [API](API.md) | Rutas, identidad firmada, datos, errores y callbacks |
| [Desarrollo](DEVELOPMENT.md) | Arranque local, scripts, pruebas y coordinación de contratos entre repositorios |
| [Railway](RAILWAY.md) | Docker, variables y despliegue de producción |
| [Operaciones](OPERATIONS.md) | Salud, mantenimiento, diagnóstico, recuperación y backups |
| [PostgreSQL](POSTGRESQL.md) | Esquema, migración e identidad persistida |
| [Facturación](BILLING.md) | Checkout, ledger, reservas, liquidación y conciliación |

Los diagramas Mermaid se visualizan directamente en GitHub. Los documentos enlazan al código correspondiente; no contienen secretos ni son una fuente de valores de credenciales.

## Recorridos recomendados

- Incorporación al proyecto: Proyecto → Arquitectura → Desarrollo.
- Cambio de interfaz o integración: API → Desarrollo → pruebas de ambos repositorios.
- Incidencia en producción: Operaciones → Railway o Facturación según el síntoma.
- Cambio financiero o de esquema: Facturación → PostgreSQL → pruebas de concurrencia nativas.

La [web](https://github.com/tomoshimoshi/tomoshimoshi) tiene su propio README y ciclo de despliegue. El [README raíz](../README.md) resume cómo ejecutar este servicio.
