# Spike: validación de la API real de `opencode serve`

**Fecha:** 2026-07-04 (ejecutado 2026-07-05 por reloj del sistema del entorno de pruebas)
**Binario probado:** `opencode` v1.17.8 (`C:\Users\Alexander\.opencode\bin\opencode.exe`)
**Método:** exploración manual con `curl.exe` contra `opencode serve --port 4573` en Windows 11 (PowerShell), más lectura del spec OpenAPI expuesto por el propio servidor en `GET /doc`.
**Modelo usado en las pruebas de prompt real:** `opencode/deepseek-v4-flash-free` (gratuito).

## Cómo se obtuvo la evidencia

1. `opencode serve --port 4573 --print-logs` se lanzó en background. El log confirma:
   ```
   Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.
   opencode server listening on http://127.0.0.1:4573
   ```
2. El servidor expone un spec OpenAPI 3.1 completo en `GET /doc` (json, ~390 KB). Esto es la fuente primaria y mucho más confiable que adivinar: se usó para enumerar **todos** los endpoints y sus schemas de request/response.
3. Se crearon 3 sesiones reales, se envió un prompt trivial, un prompt que dispara una tool call (`bash`/`ls`), y un prompt largo que se abortó a mitad de generación, capturando en paralelo el stream de `GET /event` con `curl.exe -N`.
4. El proceso `opencode.exe` (PID real, no el PID del subshell de bash) se terminó con `taskkill /F /PID <pid>` al finalizar. Verificado: `curl` a `/global/health` tras el kill devuelve `HTTP 000` (conexión rechazada).

---

## Health check

**Supuesto del plan:** `GET /app` → 200.

**Realidad:** `GET /app` devuelve `200 OK` pero el body es el **HTML de la SPA web** (`<!doctype html>...<div id="root">`), no un JSON de salud. Es la interfaz web embebida, no un endpoint de health check.

El health check real está en `GET /global/health` (también existe `GET /api/health` como alias `v2`):

```http
GET /global/health HTTP/1.1
```
```json
{"healthy":true,"version":"1.17.8"}
```

Schema (del OpenAPI): `{ healthy: true, version: string }`, ambos `required`.

---

## Endpoints

Superficie HTTP relevante para el cliente (confirmada contra `GET /doc`; hay decenas de endpoints adicionales de TUI/MCP/pty/workspace que no aplican a este plugin):

| Método | Path | operationId | Uso |
|---|---|---|---|
| GET | `/global/health` | `global.health` | Health check real |
| GET | `/session` | `session.list` | Listar sesiones |
| POST | `/session` | `session.create` | Crear sesión |
| DELETE | `/session/{sessionID}` | `session.delete` | Borrar sesión |
| GET | `/session/{sessionID}` | `session.get` | Obtener sesión |
| GET | `/session/{sessionID}/message` | `session.messages` | Listar mensajes |
| POST | `/session/{sessionID}/message` | `session.prompt` | Enviar mensaje (bloqueante) |
| POST | `/session/{sessionID}/prompt_async` | `session.prompt_async` | Variante asíncrona (no probada, ver nota abajo) |
| POST | `/session/{sessionID}/abort` | `session.abort` | Cancelar generación en curso |
| GET | `/event` | `event.subscribe` | Stream SSE global de eventos |
| GET | `/agent` | `app.agents` | Listar agentes registrados (nombres válidos para el campo `agent`) |

Nota sobre `prompt_async`: existe en el spec (`POST /session/{sessionID}/prompt_async`) pero **no se probó empíricamente** por límite de tiempo del spike. Dado que `session.prompt` (el endpoint síncrono) ya es suficiente para el flujo delegado (bloquea hasta terminar y el stream SSE en paralelo da progreso), el diseño puede apoyarse en `session.prompt` como camino principal. Si en una iteración futura se prefiere no bloquear la conexión HTTP, `prompt_async` es el candidato a investigar, pero su forma de respuesta y cómo correlaciona con los eventos no está confirmada aquí.

---

## Crear sesión (+ directorio)

**Supuesto del plan:** `POST /session` body `{ directory? }` → `{ id }`.

**Realidad confirmada:**

- El directorio de trabajo **NO se pasa en el body**. Se pasa como **query param** `?directory=<path>` (también existe `?workspace=`). El body es un objeto separado y `directory` no es una de sus propiedades.
- Si se omite `directory`, la sesión usa el `cwd` del propio proceso `opencode serve` (en las pruebas, `C:\Users\Alexander\Documents\dev\claucode`, que era el cwd desde el que se lanzó `opencode serve`).
- La respuesta no es `{ id }` sino el objeto `Session` completo.

Request real (sin query, body vacío):
```http
POST /session HTTP/1.1
Content-Type: application/json

{}
```
Respuesta real:
```json
{
  "id": "ses_0d000a6bfffekAuU1lmLPtswxo",
  "slug": "misty-engine",
  "projectID": "cda4cb31d2687c09a77efe91fb404eccc7f2ca31",
  "directory": "C:\\Users\\Alexander\\Documents\\dev\\claucode",
  "path": "",
  "cost": 0,
  "tokens": {"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},
  "title": "New session - 2026-07-05T01:58:11.520Z",
  "version": "1.17.8",
  "time": {"created":1783216691520,"updated":1783216691520}
}
```

Request real con directorio explícito por query string (URL-encoded):
```
POST /session?directory=C%3A%5CUsers%5CAlexander%5CDocuments%5Cdev%5Cclaucode
```
Devuelve la misma forma, con `directory` reflejando el valor pasado.

Body aceptado por `POST /session` (según schema OpenAPI leído de `/doc`, no verificado empíricamente; todos opcionales, `additionalProperties: false`):
```json
{
  "parentID": "string (patrón ^ses)",
  "title": "string",
  "agent": "string",
  "model": { "id": "string", "providerID": "string", "variant": "string" },
  "metadata": {},
  "permission": "PermissionRuleset",
  "workspaceID": "string (patrón ^wrk)"
}
```

Nota importante: en `POST /session` el modelo se referencia como `{ id, providerID, variant }`, mientras que en `POST /session/{id}/message` el modelo se referencia como `{ providerID, modelID }` (ver siguiente sección). **Son shapes distintos** — no reutilizar el mismo tipo TypeScript para ambos sin normalizar.

---

## Enviar mensaje (modelo/agent)

**Supuesto del plan:** `POST /session/:id/message` body `{ parts: [{type:"text",text}], model: {providerID, modelID}, agent? }`. ¿Bloqueante o async? ¿Body exacto?

**Realidad confirmada:**

- El body coincide bien con lo asumido: `parts` (requerido, array de `TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput`), `model: { providerID, modelID }` (ambos requeridos si se envía `model`), `agent` (string, top-level, opcional — nombres válidos: `build`, `plan`, `explore`, `general`, obtenibles de `GET /agent`).
- Campos adicionales soportados que el plan no mencionaba: `messageID`, `noReply` (boolean), `tools` (mapa de nombre→boolean para habilitar/deshabilitar tools), `format` (`OutputFormat`), `system` (system prompt override), `variant`.
- **`GET /doc` es explícito: `additionalProperties: false`** (leído del schema, no verificado empíricamente) — hay que enviar exactamente estas claves, cualquier clave extra puede ser rechazada.
- **Es BLOQUEANTE**, no asíncrono. La llamada HTTP `POST /session/{id}/message` no retorna hasta que el turno del asistente termina (o es abortado). El body de la respuesta HTTP 200 contiene el mensaje completo (`info`) y todas sus `parts` ya generadas.

Request real:
```http
POST /session/ses_0d000a6bfffekAuU1lmLPtswxo/message HTTP/1.1
Content-Type: application/json

{"parts":[{"type":"text","text":"Di hola y nada mas"}],"model":{"providerID":"opencode","modelID":"deepseek-v4-flash-free"}}
```

Respuesta real (HTTP 200, tras ~4.5s de espera bloqueante):
```json
{
  "info": {
    "parentID": "msg_f2fff9ace001bzKplMbwPWSpAk",
    "role": "assistant",
    "mode": "build",
    "agent": "build",
    "path": {"cwd":"C:\\Users\\Alexander\\Documents\\dev\\claucode","root":"C:\\Users\\Alexander\\Documents\\dev\\claucode"},
    "cost": 0,
    "tokens": {"total":12120,"input":12098,"output":3,"reasoning":19,"cache":{"write":0,"read":0}},
    "modelID": "deepseek-v4-flash-free",
    "providerID": "opencode",
    "time": {"created":1783216709011,"completed":1783216713560},
    "finish": "stop",
    "id": "msg_f2fff9d92001bHmjOKS5fuN3KI",
    "sessionID": "ses_0d000a6bfffekAuU1lmLPtswxo"
  },
  "parts": [
    {"type":"step-start","id":"prt_...","snapshot":"..."},
    {"type":"reasoning","text":"The user asks to say \"hello\" and nothing more...","time":{"start":...,"end":...},"id":"prt_..."},
    {"type":"text","text":"Hola","time":{"start":...,"end":...},"id":"prt_..."},
    {"type":"step-finish","reason":"stop","tokens":{...},"cost":0,"id":"prt_..."}
  ]
}
```

Si no se especifica `agent` en el request, la sesión usa el agente por defecto (`build`, visible en `info.agent`/`info.mode`).

---

## Formato SSE (con ejemplo real de los eventos relevantes para opencode-delegate)

**Supuesto del plan:** `GET /event` stream global, `data: {json}\n\n`, tipos como `message.part.updated` (con `properties.part` conteniendo `sessionID`, `type: "tool"|"text"`, nombre de tool, `state.status/input`), `session.idle` (señal de fin), `session.error`.

**Realidad confirmada — el framing SSE es correcto:** cada evento llega como una sola línea `data: {...}\n\n` (frame delimitado por línea en blanco). Envelope real:

```json
{"id":"evt_<ulid>","type":"<tipo>","properties":{...}}
```

Esto difiere ligeramente del supuesto: el objeto raíz tiene `id`/`type`/`properties`, y **el `sessionID` vive dentro de `properties`**, no en el nivel superior del part directamente en todos los casos (ver detalle por tipo abajo). El resto del supuesto (part con `type`, `state.status/input`, nombre de tool) se confirma con matices.

Tipos de evento observados en las 3 sesiones de prueba (lista real, no exhaustiva — pueden existir más, p.ej. `session.error` solo apareció al forzar un abort):

- `server.connected`, `server.heartbeat` — control de conexión SSE, sin dato de negocio.
- `plugin.added`, `catalog.updated`, `integration.updated`, `reference.updated` — ruido de arranque del servidor (carga de providers/plugins), no relacionado a una sesión concreta. **Filtrar por `properties.sessionID` cuando exista.**
- `session.updated` — snapshot del objeto `Session` cada vez que cambia (título, tokens, cost, etc).
- `session.status` — cambios de estado `{"status":{"type":"busy"|"idle"}}`.
- `session.next.agent.switched` / `session.next.model.switched` — se emiten justo antes de procesar el mensaje, informan qué agente/modelo se usará.
- `message.updated` — snapshot del objeto `Message` (`info`), tanto para el mensaje de usuario como para el de asistente, en varias etapas (creado, con `finish`, con `completed`).
- `message.part.updated` — snapshot completo de una `part` (tipos vistos: `step-start`, `reasoning`, `text`, `tool`, `step-finish`).
- `message.part.delta` — **no estaba en el supuesto del plan y es crítico para `sse-parser.ts`**: entrega deltas incrementales de streaming, forma `{sessionID, messageID, partID, field, delta}` (p.ej. `field:"text", delta:"Hola"`). El texto/razonamiento se transmite token a token vía este evento; `message.part.updated` llega al final de cada part con el contenido completo acumulado.
- `session.diff` — diffs de archivos tocados durante el turno (vacío en nuestras pruebas porque no se modificaron archivos).
- `session.idle` — **señal real de fin de turno**, confirmado.
- `session.error` — confirmado, se emite en aborts/errores.

**Nota importante sobre cobertura de ejemplos:** de los ~15 tipos enumerados arriba, **solo 5 disponen de JSON capturado empíricamente**: `message.part.updated` (dos variantes), `message.part.delta`, `session.idle`, `session.error`. Los demás tipos (`server.connected`, `server.heartbeat`, `plugin.added`, `catalog.updated`, `integration.updated`, `reference.updated`, `session.updated`, `session.status`, `session.next.agent.switched`, `session.next.model.switched`, `message.updated`, `session.diff`) fueron observados por su nombre solamente durante la ejecución; su shape de payload no se capturó. El parser en `sse-parser.ts` debe manejarlos como `kind: "other"` e ignorarlos o almacenarlos genéricamente. **Si en el futuro se requiere consumir el payload de estos eventos, es necesario volver a capturar ejemplos contra una sesión que dispare los eventos pertinentes.** (Los tipos con ejemplos son suficientes para el flujo delegado básico: streaming incremental de texto/razonamiento, tool calls con estado, y señal de fin de turno.)

### Ejemplo real: `message.part.updated` con part de texto
```json
{"id":"evt_f2fffab35001gkY5ymsr1d0AYX","type":"message.part.updated","properties":{"sessionID":"ses_0d000a6bfffekAuU1lmLPtswxo","part":{"id":"prt_f2fffab35001KCnqKtBFBa6UTu","messageID":"msg_f2fff9d92001bHmjOKS5fuN3KI","sessionID":"ses_0d000a6bfffekAuU1lmLPtswxo","type":"text","text":"","time":{"start":1783216712501}},"time":1783216712501}}
```

### Ejemplo real: `message.part.delta` (streaming incremental — NO estaba en el supuesto)
```json
{"id":"evt_f2fffaa00001CDMNNLFo47rt0q","type":"message.part.delta","properties":{"sessionID":"ses_0d000a6bfffekAuU1lmLPtswxo","messageID":"msg_f2fff9d92001bHmjOKS5fuN3KI","partID":"prt_f2fffa9f60013PySz2zybbFYUB","field":"text","delta":"The"}}
```

### Ejemplo real: `message.part.updated` con part de tipo `tool` (capturado disparando una tool call real de `bash`/`ls`)

Secuencia real completa de un tool call, en 4 actualizaciones sucesivas del mismo `part` (mismo `id`, mismo `callID`):

```json
// 1. pending
{"type":"message.part.updated","properties":{"sessionID":"ses_0cfffa1beffexJAigUd20l44pZ","part":{"id":"prt_f30008806001uVbUcPg6uqFB4r","messageID":"msg_f30007f25001s9Vf9Bkjh82GdO","sessionID":"ses_0cfffa1beffexJAigUd20l44pZ","type":"tool","tool":"bash","callID":"call_00_9tFnJZddbvy0WJNI0l8m5941","state":{"status":"pending","input":{},"raw":""}},"time":1783216769030}}

// 2. running (con input ya resuelto)
{"type":"message.part.updated","properties":{"sessionID":"ses_0cfffa1beffexJAigUd20l44pZ","part":{"type":"tool","tool":"bash","callID":"call_00_9tFnJZddbvy0WJNI0l8m5941","state":{"status":"running","input":{"command":"ls","description":"Lista archivos del directorio actual"},"time":{"start":1783216769281}},"id":"prt_f30008806001uVbUcPg6uqFB4r","messageID":"msg_f30007f25001s9Vf9Bkjh82GdO","sessionID":"ses_0cfffa1beffexJAigUd20l44pZ"},"time":1783216769281}}

// 3. running con output parcial (metadata.output)
{"type":"message.part.updated","properties":{"sessionID":"ses_0cfffa1beffexJAigUd20l44pZ","part":{"type":"tool","tool":"bash","callID":"call_00_9tFnJZddbvy0WJNI0l8m5941","state":{"metadata":{"output":"claucode-spec.md\ndocs\n","description":"Lista archivos del directorio actual"},"status":"running","input":{"command":"ls","description":"Lista archivos del directorio actual"},"time":{"start":1783216769799}},"id":"prt_f30008806001uVbUcPg6uqFB4r","messageID":"msg_f30007f25001s9Vf9Bkjh82GdO","sessionID":"ses_0cfffa1beffexJAigUd20l44pZ"},"time":1783216769799}}

// 4. completed
{"type":"message.part.updated","properties":{"sessionID":"ses_0cfffa1beffexJAigUd20l44pZ","part":{"type":"tool","tool":"bash","callID":"call_00_9tFnJZddbvy0WJNI0l8m5941","state":{"status":"completed","input":{"command":"ls","description":"Lista archivos del directorio actual"},"output":"claucode-spec.md\ndocs\n","metadata":{"output":"claucode-spec.md\ndocs\n","exit":0,"description":"Lista archivos del directorio actual","truncated":false},"title":"Lista archivos del directorio actual","time":{"start":1783216769799,"end":1783216769856}},"id":"prt_f30008806001uVbUcPg6uqFB4r","messageID":"msg_f30007f25001s9Vf9Bkjh82GdO","sessionID":"ses_0cfffa1beffexJAigUd20l44pZ"},"time":1783216769856}}
```

Diferencia clave respecto al supuesto: el nombre de la tool va en **`part.tool`** (string plano, ej. `"bash"`), no anidado dentro de `state`. `state.status` sí sigue el ciclo `pending → running → completed` como se asumía, y `state.input`/`state.output`/`state.metadata` están presentes.

### Ejemplo real: `session.idle` (señal de fin de turno)
```json
{"id":"evt_f2fffaf690023dzMt4E3nRNswh","type":"session.idle","properties":{"sessionID":"ses_0d000a6bfffekAuU1lmLPtswxo"}}
```
Nota: `session.status` con `{"status":{"type":"idle"}}` se emite justo antes y es redundante con `session.idle`; para el parser conviene usar `session.idle` como señal canónica de fin porque tiene un tipo dedicado y no requiere inspeccionar un sub-campo.

### Ejemplo real: `session.error` (emitido al abortar)
```json
{"id":"evt_f30013447001CgqVQ9je0PInSp","type":"session.error","properties":{"sessionID":"ses_0cffef9f8ffeyTSQcz66oMXIF1","error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}}}
```

---

## Cancelación

**Supuesto del plan:** `POST /session/:id/abort`.

**Confirmado tal cual.** `POST /session/{sessionID}/abort` (sin body) devuelve `200 OK` con el body `true` (booleano plano, no un objeto envuelto).

Efecto observado al abortar una generación en curso (prompt de 50 versos, abortado 2s después de iniciar):

1. La llamada bloqueante `POST /session/{id}/message` que estaba en curso **retorna igualmente con HTTP 200**, pero el `info` del mensaje trae un campo `error`:
   ```json
   {
     "info": {
       "id": "msg_f30012bf9001ZqwiZ0OG0Tw0Ii",
       "sessionID": "ses_0cffef9f8ffeyTSQcz66oMXIF1",
       "role": "assistant",
       "time": {"created":1783216811001,"completed":1783216813691},
       "error": {"name":"MessageAbortedError","data":{"message":"Aborted"}}
     },
     "parts": [
       {"type":"step-start","id":"prt_...","snapshot":"..."}
     ]
   }
   ```
   Es decir: **no hay que esperar un HTTP error ni un timeout** para detectar el abort desde el lado del `opencode-client.ts` — el propio 200 con `info.error.name === "MessageAbortedError"` es la señal.
2. En paralelo, el stream SSE recibe `session.error` (ver ejemplo arriba) y luego igualmente `session.idle` — **`session.idle` se emite también tras un abort**, así que el detector de "fin de turno" en `sse-parser.ts` debe tratar `session.idle` como fin universal (éxito, error o abort) y consultar `session.error`/`info.error` para saber si terminó bien o no.

---

## Directorio de trabajo (resumen)

Se fija exclusivamente vía **query string** `?directory=<path absoluto>` en `POST /session` (y se puede volver a pasar en casi todos los demás endpoints de sesión — `message`, `abort`, `messages`, etc. — todos aceptan `directory`/`workspace` como query params opcionales, probablemente para servers que gestionan múltiples proyectos/worktrees). Si se omite, se usa el cwd del proceso `opencode serve`. **No existe un campo `directory` en el body JSON de `POST /session`.**

## Campo `agent`

Es un string top-level tanto en `POST /session` (agente por defecto de la sesión) como en `POST /session/{id}/message` (override puntual para ese turno). Los valores válidos son los nombres devueltos por `GET /agent`; en esta instalación: `build` (agente primario por defecto), `plan` (modo solo lectura/planificación), `explore` (subagente de búsqueda), `general` (subagente propósito general), y `compaction` (interno/oculto, no usar). Si se envía un `agent` no registrado, no se probó el comportamiento exacto de error (fuera de alcance de este spike); se recomienda validar contra `GET /agent` antes de enviar.

---

## Desviaciones respecto a los supuestos del plan

Lista explícita, numerada, de qué corregir en `opencode-client.ts` y `sse-parser.ts`:

1. **Health check.** Supuesto: `GET /app` → 200 JSON. Real: `GET /app` devuelve el HTML de la SPA (200, pero no JSON). El health check real es `GET /global/health` → `{healthy:true, version:string}`. **Afecta `opencode-client.ts`**: cambiar el endpoint de health check a `/global/health` y parsear `{healthy, version}` en vez de esperar cualquier cosa de `/app`.

2. **Directorio de trabajo en `POST /session`.** Supuesto: body `{ directory? }`. Real: `directory` es **query param** (`?directory=...`), no una propiedad del body; el body de creación de sesión tiene otro shape (`parentID`, `title`, `agent`, `model`, `metadata`, `permission`, `workspaceID`). **Afecta `opencode-client.ts`**: la función `createSession(directory?)` debe construir la URL con `?directory=` en vez de meter `directory` en el JSON del body.

3. **Forma de respuesta de `POST /session`.** Supuesto implícito: `{ id }`. Real: devuelve el objeto `Session` completo (`id, slug, projectID, directory, path, cost, tokens, title, version, time`). **Afecta `opencode-client.ts`**: el tipo de retorno de `createSession` debe modelar el `Session` completo, no solo `{id}` (aunque solo se use `id` inicialmente, el parseo debe tolerar/tipar los demás campos o al menos no fallar con ellos).

4. **`POST /session/:id/message` es bloqueante, no fire-and-forget.** Supuesto: no estaba resuelto si era bloqueante o async; el diseño original asumía que había que escuchar `/event` para saber cuándo terminó. Real: la propia llamada HTTP se mantiene abierta y **no retorna hasta que el turno termina** (incluida terminación por error o abort), devolviendo el mensaje completo con todas sus `parts` en el body de respuesta. **Afecta `opencode-client.ts`**: el cliente puede (y probablemente debe) usar la respuesta del POST como fuente de verdad final del resultado, en vez de depender exclusivamente del stream SSE para detectar el fin — el SSE sigue siendo necesario para progreso incremental (deltas, tool calls en vivo), pero no es la única fuente para "¿terminó y con qué resultado?". Hay que decidir el timeout HTTP del cliente considerando que esta llamada puede tardar minutos.

5. **Modelo con shape distinto entre `session.create` y `session.prompt`.** Supuesto: un único shape `{providerID, modelID}`. Real: `POST /session` usa `model: {id, providerID, variant}` mientras que `POST /session/{id}/message` usa `model: {providerID, modelID}` (dos claves distintas para "el modelo": `id` vs `modelID`). **Afecta `opencode-client.ts`**: no debe existir un único tipo `Model` compartido entre ambos payloads; hay que definir dos tipos (`SessionModelRef` y `MessageModelRef`) o normalizar explícitamente.

6. **Envelope de eventos SSE.** Supuesto: `data: {json}` con el tipo y `properties.part` conteniendo directamente `sessionID`. Real: el envelope es `{id, type, properties}` y el `sessionID` vive dentro de `properties` (a veces `properties.sessionID` a nivel del evento, a veces también repetido dentro de `properties.part.sessionID`). Además hay ruido de eventos globales sin `sessionID` (`plugin.added`, `catalog.updated`, etc., típicamente al arrancar el server) que `sse-parser.ts` debe ignorar/filtrar si no trae `properties.sessionID` coincidente con la sesión de interés.

7. **Falta `message.part.delta` en el supuesto.** El plan no contemplaba este tipo de evento. Real: es el mecanismo de **streaming token a token** (`{sessionID, messageID, partID, field, delta}`); `message.part.updated` solo llega al crear la part y al finalizarla con el contenido acumulado completo. **Afecta `sse-parser.ts` fuertemente**: si se quiere UX de streaming incremental real (no solo "esperar a que termine"), el parser debe manejar `message.part.delta` acumulando por `partID`+`field`, no solo `message.part.updated`.

8. **Shape de la part `tool`.** Supuesto: `state.status/input`, "tool name" sin especificar dónde. Real: confirmado el ciclo `state.status: pending|running|completed`, pero el **nombre de la tool está en `part.tool`** (string, ej. `"bash"`), no dentro de `state`. `state.input` es el input estructurado, `state.output`/`state.metadata.output` es la salida (aparece progresivamente durante `running` y de forma definitiva en `completed`), y `state.metadata.exit`/`truncated` dan info adicional de ejecución. **Afecta `sse-parser.ts`**: leer el nombre de la tool de `part.tool`, no de un campo dentro de `state`.

9. **Señal de fin de turno y su relación con errores/abort.** Supuesto: `session.idle` como señal de fin, `session.error` para errores, sin especificar su interacción. Real confirmado: `session.idle` se emite **siempre** al final del turno, sea éxito, error de modelo o abort explícito. `session.error` se emite además cuando hay error/abort, con `properties.error.name` (visto: `"MessageAbortedError"`) y `properties.error.data.message`. **Afecta `sse-parser.ts`**: tratar `session.idle` como la señal universal de "el turno terminó" y usar la presencia (o no) de un `session.error` previo / de `info.error` en la respuesta HTTP para decidir éxito vs. fallo vs. abort — no asumir que `session.idle` implica éxito.

10. **Cancelación: confirmado sin cambios, con una precisión.** El endpoint y método (`POST /session/{id}/abort`, sin body) coinciden exactamente con el supuesto y responden `200` con body `true` (booleano plano). La precisión que faltaba: el efecto se observa en la llamada bloqueante de `session.prompt` en curso, que retorna con `info.error.name === "MessageAbortedError"` en vez de cortar la conexión — `opencode-client.ts` debe tratar esto como un resultado normal de la promesa (no una excepción HTTP) y decidir en la capa de negocio si eso constituye un "error" delegable al usuario.

---

## Evaluación del gate del plan

La API **no difiere radicalmente** de lo asumido en su superficie general: los endpoints de sesión, el stream de eventos SSE y el endpoint de abort existen y funcionan tal como se anticipó a alto nivel. Las diferencias encontradas son de **detalle de forma** (dónde va el directorio, shape de `model`, naming de la tool, un tipo de evento adicional para streaming) y de **semántica de bloqueo** (el POST de mensaje es síncrono, algo que el plan dejaba como pregunta abierta). Ninguna de estas diferencias invalida la arquitectura propuesta (cliente HTTP + parser SSE). **No se activa el gate de bloqueo; se puede proceder con las Tareas 6, 7 y 8 ajustando `opencode-client.ts` y `sse-parser.ts` según la lista de desviaciones de arriba.**

## ¿Es este documento suficiente para implementar el cliente sin correr `opencode`?

Sí, con las siguientes salvedades explícitas:
- **Cobertura incompleta de eventos SSE.** De los ~15 tipos de evento enumerados, solo 5 tienen ejemplos JSON capturados (`message.part.updated` x2 variantes, `message.part.delta`, `session.idle`, `session.error`). Los demás tipos fueron observados por nombre solamente. El parser debe manejar eventos sin ejemplo como `kind: "other"` e ignorarlos o guardarlos genéricamente. Si la implementación futura requiere consumir estos eventos, será necesario volver a ejecutar capturas contra sesiones que disparen esos tipos específicos.
- El shape completo de `Session`, `Message` y `Part` (todas las variantes de `part.type`) no se transcribió íntegro desde el OpenAPI (solo los campos vistos en la práctica); para tipos TypeScript exhaustivos conviene además consultar `GET /doc` en el momento de implementar y extraer `components.schemas.Session` / `Message` / `Part` completos.
- `POST /session/{id}/prompt_async` no fue probado; si se decide usarlo en vez de la variante síncrona, requiere un mini-spike adicional antes de codificarlo.
- El comportamiento ante un `agent` inválido o un `model` inexistente no fue probado (errores 400 con qué shape exacto) — se infiere de `BadRequestError`/`InvalidRequestError` en el spec pero no se capturó un ejemplo real.
