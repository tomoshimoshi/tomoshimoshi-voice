# El proyecto

Esta guía describe la implementación tras la separación de repositorios del 22 de septiembre de 2026. Los enlaces al código y las guías operativas son la referencia para actualizarla.

## Qué hace ToMoshiMoshi

Permite preparar una llamada telefónica y delegar la conversación a un asistente de voz. El usuario escribe el objetivo, proporciona los datos necesarios, elige el idioma de la llamada y revisa las condiciones antes de autorizarla. Durante la conversación puede leer la transcripción, responder preguntas privadas y colgar.

Casos incluidos: pedir una cita, reservar una mesa, pedir información, hacer seguimiento y redactar una tarea personalizada. La interfaz está en español e inglés; la conversación telefónica admite japonés, inglés y español. Los destinos admitidos actualmente son números válidos de Japón, restringidos además por `ALLOWED_PHONE_NUMBERS`.

## Dos repositorios, un producto

| Repositorio | Responsabilidad | Ejecución |
| --- | --- | --- |
| [tomoshimoshi](https://github.com/tomoshimoshi/tomoshimoshi) | Interfaz Next.js, Auth0, preparación de llamadas y proxy autenticado `/api/*` | Vercel |
| [tomoshimoshi-voice](https://github.com/tomoshimoshi/tomoshimoshi-voice) | API de negocio, sesiones de voz, proveedores, persistencia, saldo y cobros | Railway, proceso Node persistente |

Neon almacena los datos. Auth0 identifica al usuario. Telnyx conecta con el teléfono; OpenAI genera la conversación y procesa las transcripciones. Stripe gestiona Checkout y eventos de recarga; el código de esta versión solo admite su modo de prueba.

La web se comunica con voz mediante HTTPS y no importa su código en ejecución. Las carpetas `lib/` contienen copias de algunos modelos y utilidades comunes; todavía no existe un paquete compartido publicado.

## Recorrido del usuario

1. Inicia sesión con Auth0. Puede explorar antes de verificar su correo, pero para marcar necesita correo verificado y perfil con nombre y apellidos.
2. Elige el objetivo y un destinatario. Google Maps es opcional; la búsqueda ocurre en el navegador usando una clave restringida. Los contactos guardan referencias a lugares, no una copia completa de sus resultados.
3. Revisa contexto, límites y permiso para compartir el perfil. Compartirlo es una decisión por llamada; no se deduce de haber guardado un perfil.
4. El backend valida la petición y reserva crédito antes de pedir a Telnyx que marque.
5. Sigue la transcripción. Si falta un dato o una autorización, el asistente utiliza `ask_user` y mantiene la misma llamada a la espera.
6. Al terminar se guardan el resultado y el historial. El cargo se liquida con evidencia del proveedor; una llamada terminada puede tener todavía un cobro pendiente de conciliación.

## Capacidades y límites actuales

| Área | Implementado | Límite |
| --- | --- | --- |
| Identidad | Sesión Auth0 y aislamiento por usuario en la API/SQL | No se presenta como aislamiento mediante RLS |
| Concurrencia | Varios usuarios pueden llamar; una llamada activa por usuario | Un único worker por base de datos |
| Audio | Puente bidireccional PCMU a 8 kHz | Una sesión no se transfiere a otro proceso al reiniciar |
| Idiomas | Idioma telefónico separado del idioma de interfaz | La calidad depende del modelo, del audio y del destinatario |
| Crédito | Recarga, reserva, captura, liberación y registro contable | Stripe rechaza claves/eventos live; la puesta en servicio de recargas exige configurar y probar su endpoint |
| Recuperación | Cuelgue pendiente persistido y reintentos | Tras reiniciar, las llamadas anteriores fallan; no se reanudan automáticamente |
| Observabilidad | Healthcheck, eventos estructurados y conciliación manual | No hay consumidor de outbox ni planificador de conciliación en este repositorio |

La aplicación no guarda archivos de audio. Sí persiste perfiles, transcripciones y resultados; los datos necesarios se transmiten a los proveedores. La retención de terceros es independiente. No hay una política automática de borrado de transcripciones implementada aquí.

## Dónde empezar

- Para comprender las piezas y decisiones: [arquitectura](ARCHITECTURE.md).
- Para trabajar en local: [desarrollo](DEVELOPMENT.md).
- Para integrar la web: [contrato HTTP y WebSocket](API.md).
- Para desplegar o diagnosticar: [operaciones](OPERATIONS.md) y [Railway](RAILWAY.md).
- Para modificar persistencia o dinero: [PostgreSQL](POSTGRESQL.md) y [facturación](BILLING.md).
