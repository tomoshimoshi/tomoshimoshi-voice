# Latencia y ubicación de servicios — 23 de septiembre de 2026

## Línea base verificada en producción

La consola de Railway confirmó que `DATABASE_URL_POOLED` apunta a
`ap-southeast-1.aws.neon.tech` (Singapur). Solo se imprimió la región del host,
nunca las credenciales. Vercel mostraba `iad1` en Function Region, con Fluid
Compute habilitado. Railway ejecutaba una réplica en `sfo`.

Recorrido de la interfaz: Japón → Vercel Virginia → Railway California → Neon
Singapur. El audio no pasa por Vercel: teléfono ↔ Telnyx ↔ Railway ↔ OpenAI.

Mediciones de diagnóstico desde el contenedor de California, sin llamadas:

| Medida | Resultado |
| --- | --- |
| Nueva conexión PostgreSQL TLS | 1.415 ms |
| Diez `SELECT 1` en la misma conexión | 228, 226, 230, 1.195, 220, 207, 228, 225, 228, 229 ms |
| Mediana de consulta | 228 ms |
| Conexión WebSocket OpenAI | 3.169 ms (una muestra) |
| Diez ping/pong del WebSocket | 45, 44, 44, 44, 44, 44, 45, 118, 57, 43 ms |
| Primer audio sintético Realtime 2.1, tres sesiones | 437, 480, 471 ms; mediana 471 ms |
| Preparación de esas sesiones hasta `session.updated` | 321, 301, 591 ms |
| `/healthz` público desde Japón | 500 ms (una muestra; incluye una consulta a Neon) |

Las tres generaciones usaron PCMU, voz `marin`, razonamiento `low`, contexto
vacío y la frase artificial «Thank you. Have a good day.». No se enviaron audio
de personas ni datos de llamadas, ni se marcó un teléfono. Ping/pong mide el
transporte, no la inferencia. La variación de las conexiones muestra que una
muestra no basta para atribuir todo el tiempo a distancia geográfica.

Logs HTTP posteriores al primer despliegue: `/state` normalmente alrededor de
0,7–0,9 s dentro de Railway, con algunos valores de 1,4–2,6 s. Estos tiempos no
incluyen todo el recorrido del navegador. CPU máxima de las dos horas anteriores:
0,0293 núcleos; memoria máxima: 0,1301 GB. No hay evidencia de saturación de CPU
o memoria como causa principal en ese intervalo.

## Interpretación

Las consultas secuenciales atraviesan el Pacífico repetidamente. Incluso un
`SELECT 1` tarda unos 228 ms, por lo que optimizar el SQL no puede eliminar ese
suelo de red. El pool evita negociar TLS en cada solicitud, pero cada consulta
sigue pagando la distancia. La interfaz añade además su intervalo de polling.

La conversación conserva otros componentes: 500 ms configurados de silencio
VAD, generación del primer audio, transporte y reproducción de Telnyx. El
primer audio sintético no reproduce una llamada telefónica completa. El código
no fija `sip_region`; Telnyx documenta `US` como valor predeterminado de Dial.
Esto no demuestra dónde se procesó el audio de una llamada concreta. No se
cambió el enrutamiento SIP basándose solo en proximidad geográfica.

## Prueba regional autorizada

El usuario autorizó explícitamente la interrupción breve, comparar Railway en
Singapur y mover Vercel a Singapur si los resultados lo justificaban. Antes de
la parada se comprobó que no había llamadas en `dialing`, `connected` o `waiting`.
Se mantiene una sola réplica y el bloqueo exclusivo de PostgreSQL. La base de
datos no se migra ni se duplica.

El despliegue anterior se detuvo antes de aplicar el cambio de `sfo` a
`asia-southeast1-eqsg3a`. Volver atrás requiere el mismo procedimiento de parada
y sustitución; nunca arrancar dos workers sobre la misma base.

## Resultado en Singapur

Railway terminó el despliegue `b317c0a7-19a8-4d3e-9f0a-1da5ee3c45cc` con estado
`SUCCESS`; el worker anunció arranque a las 15:54:01 JST. Se verificó que la
configuración contiene únicamente una réplica en `asia-southeast1-eqsg3a`.

| Misma medición | California | Singapur |
| --- | --- | --- |
| Nueva conexión PostgreSQL | 1.415 ms | 54 ms |
| Mediana de diez `SELECT 1` | 228 ms | 4 ms |
| `/state` dentro de Railway, servicio caliente | Habitualmente 700–900 ms | Habitualmente 19–50 ms |
| Mediana de primer audio sintético, tres sesiones por región | 471 ms | 651 ms |

Consultas en Singapur: 5, 3, 4, 7, 4, 3, 3, 4, 4, 3 ms. Primer audio en
Singapur: 635, 651, 811 ms; preparación de sesión: 1.149, 964, 1.256 ms.
La reducción mediana de la consulta mínima fue del 98,2 %, pero la muestra
de audio añadió 180 ms a su mediana. **No se demostró que la conversación
telefónica fuera más rápida.** Son muestras pequeñas, tomadas secuencialmente,
no una comparación estadística bajo carga idéntica.

La primera petición pública de salud tras mover la región tardó 3,47 s.
Las cinco siguientes desde Japón tardaron 928, 172, 178, 278 y 174 ms
(mediana 178 ms), todas con HTTP 200. La línea base pública de California
solo tuvo una muestra de 500 ms y no permite una comparación robusta de p95.

Se conserva Singapur por la mejora de datos y de intervención privada.
El usuario fue informado del coste observado en el primer audio sintético.
Vercel se configura en `sin1` mediante `vercel.json` del repositorio web,
eliminando el paso por Virginia para las funciones. No se requiere un plan
de múltiples regiones ni se aumenta el número de réplicas.

Vercel publicó el commit `3f7630c` en el despliegue
`HWFwJfB5mPgyBqPTxKcmSqrZTHYK` con estado `Ready`. Su tabla de recursos confirma
`SIN1` para `/api/[...path]` y las páginas; el middleware sigue distribuido
globalmente. El dashboard autenticado cargó historial y saldo correctamente
después de refrescarlo. No se realizó una llamada telefónica para esta comparación.

## Qué queda por medir

- En una nueva llamada controlada: `voice.first_audio` (`turnMs`, `modelMs`,
  `answerMs`), `voice.playback_complete` y `voice.session_ready`.
- Los 500 ms de VAD y la generación de audio siguen existiendo; la distancia
  de la base no explicaba todos los silencios de la llamada original.
- Evaluar la ruta SIP/medios de Telnyx con audio real antes de cambiar `sip_region`.
  Australia es una opción documentada, pero estar más cerca no garantiza una
  mejor ruta hacia el modelo o hacia un número japonés.
- Si domina el retardo de audio, comparar una arquitectura con medios cerca de
  los proveedores y control/datos en Asia. No convertir esta prueba en una
  migración de base de datos o de proveedor sin medir ese recorrido completo.

Fuentes: [regiones de Railway](https://docs.railway.com/deployments/regions),
[regiones de Vercel Functions](https://vercel.com/docs/functions/configuring-functions/region),
[Dial y `sip_region` de Telnyx](https://developers.telnyx.com/api-reference/call-commands/dial).
