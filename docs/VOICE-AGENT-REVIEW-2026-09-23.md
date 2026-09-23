# Evaluación del agente tras la llamada del 23 de septiembre de 2026

La conexión y el intercambio de audio funcionaron. **El transcript aportado no demuestra una cita confirmada**: la preferencia privada por las 10:00 autoriza a solicitar esa hora, pero falta una respuesta posterior de la clínica. El agente convirtió su propia pregunta en un resultado y se despidió. No se modificó el registro histórico de esa llamada.

## Diagnóstico

| Observación | Evidencia y causa | Corrección implementada |
| --- | --- | --- |
| La petición al usuario pasa desapercibida | Tarjeta lateral con anuncio `polite`; en móvil quedaba fuera del foco principal. | Diálogo central nativo, foco en la respuesta, fondo atenuado, título de pestaña, aviso persistente al minimizar y disponibilidad desde cualquier sección del espacio. |
| Espera sin explicación al destinatario | El prompt pedía un preámbulo, pero el servidor asumía que ya se había pronunciado. Solo respondía al destinatario después de un enfriamiento de 15 segundos. | Al aceptar `ask_user`, el servidor solicita una frase breve en el idioma telefónico; recordatorio cada 20 segundos y respuesta a nuevas intervenciones con enfriamiento de 8 segundos. Las herramientas están deshabilitadas en esos turnos. |
| El agente declara éxito solo | `finish_call` aceptaba el resultado del modelo y calculaba cuándo colgar, sin exigir evidencia posterior. | Fase `confirm_details`, prueba temporal de una intervención nueva y comprobación semántica independiente antes de guardar éxito. |
| Despedida y colgado demasiado pronto | Estimación con bytes/tiempo de audio; no se esperaba el acuse de reproducción de la despedida. | Despedida controlada por el servidor, acuse `mark` de Telnyx y 1,2 segundos para permitir una corrección. Una interrupción invalida el cierre y el resultado. Hay un límite de respaldo de 30 segundos si falta el acuse. |
| Retraso al mostrar estado o contestar | Cada petición ejecutaba una transacción de identidad con consultas secuenciales; el detalle consultaba dos veces la misma llamada. | Identidad sin cambios: una consulta de lectura. Se elimina la lectura duplicada y se incorpora el estado en memoria de la llamada activa, conservando autorización por propietario y facturación de la base. |

Aspectos que ya funcionaban: identificación como asistente virtual, comprensión de las opciones, separación entre español privado e inglés telefónico y uso del nombre completo. La principal deficiencia era la gestión de turnos y evidencia, no la comprensión de «10 de la mañana».

## Contrato de voz y garantías del servidor

1. Obtener información y permisos dentro del objetivo. La aprobación privada no es una respuesta del destinatario.
2. Si falta información, emitir `ask_user` sin preámbulo adicional. La pregunta privada se muestra en el idioma de la interfaz; la espera se pronuncia en el idioma telefónico.
3. No aceptar una pregunta pendiente como aprobación, ni sustituirla por otra. Los temporizadores pertenecen a su pregunta concreta.
4. Solicitar los detalles exactos mediante `confirm_details`. Ese turno no tiene herramientas y debe acabar esperando.
5. Para aceptar éxito, exigir una intervención cuyo **inicio** sea posterior al acuse de reproducción de esa pregunta. Solo vale la última intervención comprometida por VAD y su transcripción completa original; no una traducción, fragmento, frase del agente o mensaje privado.
6. Una segunda comprobación con `gpt-4.1-mini` determina si la respuesta confirma realmente la pregunta. Saludos, disponibilidad, condiciones, cambios y negativas no deben pasar. La consulta se prepara en paralelo al modelo de voz al llegar la transcripción, se reutiliza solo para esa intervención/fase y falla de forma conservadora.
7. Volver a comprobar la evidencia después de la consulta asíncrona: una corrección, nueva respuesta privada o cancelación puede haber llegado mientras tanto.
8. Solo entonces guardar éxito y generar la despedida. Un resultado incompleto tampoco puede cerrar inmediatamente después de una respuesta privada sin una nueva intervención del destinatario.
9. Si el usuario no responde en 90 segundos, explicar que no se puede confirmar antes de terminar por `ANSWER_TIMEOUT`.

Las frases de espera, confirmación y despedida usan `response.input: []`. Esto excluye de su generación el contexto privado y las instrucciones anteriores, pero añade la frase resultante a la conversación principal. Una evaluación directa del modelo reprodujo la contaminación de la espera sin este aislamiento; con él pronunció la frase prevista.

El prompt también separa idiomas por campo, limita preámbulos y longitud, conserva nombres y fechas, distingue disponibilidad/reserva y obliga a resolver cambios antes de confirmar. Las reglas de negocio no descansan únicamente en ese prompt.

## Latencia y regiones

En los logs de Railway de esta llamada, entre 14:45 y 14:47 JST:

- Consultas de detalle: aproximadamente **1,7–3,7 s** dentro del recorrido HTTP medido por Railway.
- Envío de la respuesta privada: **3.066 ms**.
- Creación de llamada: **11.127 ms**; incluye trabajo de autorización/proveedor y no equivale al retardo entre turnos.
- El intervalo anterior de consulta de detalle añadía **1,2 s después de cada respuesta HTTP**. Por eso la interfaz podía actualizarse aproximadamente cada 3–5 s, incluso sin un fallo de audio.

Railway confirma una réplica en **San Francisco (`sfo`)**. La configuración local de Neon apunta a **Singapur (`ap-southeast-1`)**; las variables de Railway están ocultas por OAuth, por lo que esto NO verifica la región de la base usada en producción. El conector Vercel disponible no expone este proyecto; no se pudo comprobar la región efectiva de sus funciones.

Ruta de audio: teléfono ↔ Telnyx ↔ Railway ↔ OpenAI Realtime. Vercel y las traducciones no transportan ese audio. Ruta de intervención: navegador ↔ Vercel ↔ Railway ↔ OpenAI, con consultas de autorización/persistencia a Neon. Mover Vercel puede mejorar la intervención, pero no elimina por sí mismo la latencia telefónica.

Cambios adicionales:

- VAD pasa de 650 a 500 ms de silencio; reduce 150 ms de espera configurada, sin prometer esa mejora en el tiempo total.
- Consultas secuenciales del detalle cada 800 ms cuando está visible; se actualiza al volver a la pestaña. El estado global consulta con más frecuencia durante una llamada. No se solapan consultas del mismo bucle.
- Las traducciones siguen en segundo plano.
- Eventos `voice.session_ready`, `voice.first_audio`, `voice.playback_complete`, `voice.user_answer`, `voice.completion_blocked` y `voice.confirmation_checked` registran tiempos/fase sin texto ni audio privado.

Antes de cambiar regiones, medir estos eventos en una llamada controlada y confirmar dónde está Neon en producción. Si efectivamente está en Singapur, comparar un worker aislado en esa región contra San Francisco: medir acceso a Neon, primer audio de OpenAI y reproducción telefónica. Acercar el worker a la base puede reducir mucho el coste de consultas, pero una región elegida solo por cercanía al usuario puede empeorar otro tramo. No se cambiaron regiones de producción ni el bloqueo de worker único.

## Modelos

| Función | Configuración anterior/local | Configuración preparada | Evaluación |
| --- | --- | --- | --- |
| Conversación | `gpt-realtime` | `gpt-realtime-2.1`, razonamiento `low` | Disponible en el proyecto OpenAI. Sesión real de API aceptó PCMU, voz `marin` y razonamiento bajo. |
| Transcripción | `gpt-4o-mini-transcribe` | Snapshot `gpt-4o-mini-transcribe-2025-12-15`, configurable por `OPENAI_TRANSCRIPTION_MODEL` | Snapshot disponible; conserva el papel de transcripción auxiliar. No se usa como motor de conversación. |
| Traducciones | `gpt-4.1-mini` | Se conserva | Trabajo breve con salida estructurada; cambiarlo a un modelo de razonamiento no mejora necesariamente el tiempo ni el coste. |
| Verificación final | No existía | `gpt-4.1-mini` | Una decisión estructurada acotada; timeout de 5 segundos y rechazo conservador ante errores. |

El catálogo también ofrece Realtime 2.1 mini, GPT-Live y nuevos modelos de transcripción. GPT-Live requiere otra interfaz/arquitectura; no se sustituyó el puente probado por una migración completa sin evaluación de telefonía. La disponibilidad en el catálogo no demuestra calidad acústica o menor latencia para esta llamada.

Realtime 2.1 mantiene las tarifas publicadas de audio de Realtime ($32/$64 por millón de tokens de entrada/salida), pero su texto de salida publicado es más caro ($24 frente a $16) y añade razonamiento. No se cambió la tarifa al usuario. La verificación final añade una pequeña petición de texto.

**Los overrides de Railway tienen prioridad sobre los nuevos defaults.** Al desplegar, establecer explícitamente `OPENAI_REALTIME_MODEL=gpt-realtime-2.1` y `OPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe-2025-12-15`. Se mantiene compatibilidad con el modelo anterior: no se le envía el parámetro de razonamiento.

## Verificación realizada y límites

- Node 24: backend con **91/91 pruebas**, web con **40/40 pruebas** y build correcto; lint, TypeScript y contratos compartidos verificados.
- Regresiones del puente: pregunta sin audio previo, espera, respuesta privada, evidencia antigua, transcripción tardía, reproducción interrumpida, corrección durante despedida, timeout y aislamiento entre propietarios.
- Navegador con backend ficticio: escritorio y móvil de 390 px, foco automático, respuesta enviada, cierre del diálogo, Escape, aviso persistente y aparición desde el dashboard. Sin desbordamiento horizontal ni overlay de error.
- API real, sin telefonía: configuración de sesión Realtime 2.1.
- Verificador real: **8/8 casos sintéticos**, incluyendo confirmación en tres idiomas, disponibilidad, saludo, condición, corrección y negativa. Duraciones observadas de 585–4.315 ms desde el entorno local; no son medidas desde Railway.
- Realtime real en modo texto y con generación de audio PCMU (entradas sintéticas de texto): espera aislada correcta, aprobación privada sin éxito prematuro, saludo sin éxito, readback y éxito únicamente tras nueva confirmación explícita. El modelo puede usar un turno normal para solicitar la hora antes de invocar `confirm_details`; el servidor sigue exigiendo esa fase antes de aceptar éxito.

No se realizó otra llamada telefónica, no se capturó audio de personas ni se desplegaron cambios. La evaluación con audio generado también mostró variación residual en preámbulos y en el idioma del resumen privado; esos detalles del modelo no se consideran garantizados por las pruebas de seguridad del cierre. Una evaluación sintética no demuestra ausencia de errores: el clasificador sigue siendo probabilístico, y una transcripción incompleta puede provocar una aclaración adicional. La puerta temporal es deliberadamente conservadora si el destinatario empieza a responder antes de terminar el readback. La nueva espera de VAD necesita una comprobación acústica con japonés, inglés, ruido e interrupciones.

El despliegue de Voice requiere una ventana sin llamadas activas y detener el worker anterior antes de iniciar el nuevo, conforme a `AGENTS.md` y `docs/RAILWAY.md`. Después: comprobar salud, hacer una llamada controlada y comparar tiempos con la línea base anterior.

Fuentes: [Realtime 2.1](https://developers.openai.com/api/docs/models/gpt-realtime-2.1), [Realtime y contexto por respuesta](https://developers.openai.com/api/docs/guides/realtime-conversations), [prompting de voz](https://developers.openai.com/api/docs/guides/voice-prompting), [GPT-4.1 mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [reproducción y marcas de Telnyx](https://developers.telnyx.com/docs/voice/programmable-voice/media-streaming).

## Despliegue posterior autorizado — 23 de septiembre de 2026

El usuario confirmó que no había llamadas activas y autorizó publicar ambos servicios.
Vercel publicó `3f44989` en producción (despliegue `7Da6vPHKzEwPLNMVGLoNt9nnQfta`).
Railway publicó `5280c09` (despliegue `13001eee-93bf-4504-b16a-2f3f5a1b7c11`),
con arranque registrado a las 15:44:40 JST y estado `SUCCESS`.
Los dos overrides de modelos indicados arriba se guardaron antes de ese despliegue.

Se detuvo el worker anterior antes de sustituirlo. Un intento intermedio con
`Redeploy` seleccionó el código anterior; se canceló y se utilizó
`Deploy latest commit`, verificando el SHA. El procedimiento de Railway ya
documenta esta diferencia.

Comprobaciones en producción: `/healthz` respondió 200 con `status: ok`, `/state`
sin credenciales respondió 401, y el dashboard autenticado volvió a cargar
historial y saldo sin el error de mantenimiento. No se hizo una llamada real
adicional ni se cambiaron las regiones de infraestructura. La validación acústica
posterior y la medición de latencia durante una nueva llamada siguen pendientes.
