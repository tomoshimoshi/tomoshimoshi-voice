# Segunda prueba real: confirmación y respuesta privada

La prueba de las 16:26–16:28 JST terminó porque el usuario pulsó «Terminar
llamada» en la interfaz. No fue una despedida ni un cierre autónomo del agente.
No se modifica su registro histórico ni su resultado cancelado.

## Evidencia

Los logs del worker muestran `voice.confirmation_checked` con `confirmed: true`
a las 16:27:49 y 16:28:11 JST, con verificaciones de 755 y 812 ms. Ambas fueron
seguidas por `voice.completion_blocked`. El verificador semántico sí aceptaba la
respuesta; el cierre exigía además que `confirmation_quote`, escrito por el
modelo de voz, coincidiera literalmente con la transcripción independiente.
Ese campo podía diferir por puntuación, redacción o idioma. Los logs existentes
no guardan la cita del modelo, por lo que no se atribuye la diferencia a un
carácter concreto. La comprobación temporal había pasado al iniciar ambas
verificaciones. No es un fallo atribuible a la distancia entre servidores.

El mensaje privado se introducía como un turno de usuario, sin prohibir
explícitamente responderle en voz alta. La frase «Perfect, we will request…»
es una respuesta a esa coordinación, pronunciada al destinatario equivocado.

## Cambios

- El servidor obtiene la última transcripción original elegible por ID de turno;
  el modelo ya no tiene que copiarla en `finish_call`. Se verifica la respuesta
  completa, incluidas negativas, condiciones y correcciones.
- Se conservan el readback reproducido, la nueva intervención del destinatario,
  el bloqueo tras respuestas privadas y la revisión posterior a la verificación.
- Si el modelo termina antes de que llegue ASR, el servidor espera hasta dos
  segundos por esa transcripción, sin generar otra pregunta durante la espera.
- Un «sí» directo basta tras la pregunta final. El contrato prohíbe repetirla
  después de una afirmación clara o explicar verificaciones internas en voz alta.
- La respuesta privada se etiqueta como datos internos. El siguiente turno
  refuerza que todo audio se dirige al destinatario, incluso si quedó en cola
  mientras se reproducía la espera. Debe solicitar la opción o comunicar el dato
  directamente, sin agradecer al usuario privado ni anunciarle un plan.
- Los bloqueos de cierre registran el motivo sin incluir contenido privado.

## Verificación

`npm run check` con Node 24: lint y TypeScript correctos, 97/97 pruebas.
Regresiones: ASR «Sí.» con cita del modelo «Yes», ausencia de cita, transcripción
tardía, respuesta condicionada, corrección durante verificación y cancelación
desde la interfaz. Se conservan las pruebas de evidencia anterior, readback
interrumpido y reproducción de despedida. Todos los proveedores están simulados
y la base de pruebas está aislada. Las pruebas del contrato verifican las
instrucciones enviadas, no garantizan por sí solas cada frase del modelo real.

No se hacen llamadas reales durante esta reparación. La validación telefónica
posterior debe comprobar que, tras elegir las 14:00, solo se solicita esa hora
a la clínica y un único «sí» a la lectura final conduce a la despedida.
