# Claucode — Plugin de Claude Code para delegar subagentes a OpenCode

> Nombre elegido: **Claucode** (fusión Claude + Code).
> Alternativas consideradas: Hermes, Janus, Bifrost, Relay, OpenClaude,
> Cloudcode, Overcast.
>
> **Nota de marca:** a diferencia de las otras opciones, "Claucode" sí
> incorpora directamente parte del nombre "Claude". Si el plugin se queda de
> uso interno no hay problema; si en algún momento se piensa publicar/
> distribuir públicamente, vale la pena revisar los lineamientos de marca de
> Anthropic antes (los proyectos de referencia de la sección 4 evitaron
> literalmente "Claude"/"Anthropic"/"OpenAI" en el nombre del paquete por esta
> misma razón — usaron "codex"/"opencode", no "openai"/"anthropic").

## 1. Objetivo

Que Claude Code, en vez de lanzar sus subagentes por defecto (Sonnet/Opus/Haiku
vía el Agent tool nativo), pueda delegar esas mismas tareas a modelos
gestionados por **OpenCode** (`opencode-ai`, CLI `opencode`), usando **MCP**
como mecanismo de conexión y replicando — en la medida de lo posible — la
misma estructura/contrato que usa el Agent tool nativo para lanzar subagentes.

No se trata de reemplazar el loop principal de Claude Code (eso no es posible,
está atado a la API de Anthropic), sino de que el agente orquestador pueda
decidir, tarea por tarea, delegarla a OpenCode como si fuera "otro subagente
más" — con el mismo vocabulario de parámetros que ya conoce.

## 2. Cómo lanza Claude Code sus subagentes hoy (investigación confirmada)

Fuente: inspección directa de `sdk-tools.d.ts` del paquete npm
`@anthropic-ai/claude-code` (JSON Schema real de las tools) y del repo público
`github.com/anthropics/claude-code` (en particular `plugins/plugin-dev/` — los
propios plugins de ejemplo de Anthropic para desarrollar plugins — y el
`CHANGELOG.md`).

### Contrato del Agent tool (`AgentInput`)

```ts
{
  description: string;         // 3-5 palabras
  prompt: string;               // la tarea completa
  subagent_type?: string;       // qué definición de agents/*.md usar
  model?: "sonnet" | "opus" | "haiku" | "fable"; // override puntual
  run_in_background?: boolean;  // default true
  name?: string;                 // si se nombra, es una "teammate" addressable
  mode?: "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
  isolation?: "worktree" | "remote";
}
```

### Qué contexto recibe realmente un subagente

- **No hereda el historial completo** de la conversación padre. Recibe: su
  propio system prompt (cuerpo markdown de `agents/*.md`) + el campo `prompt`
  como orden puntual. Confirmado en el CHANGELOG: *"Subagents now treat
  messages from the agent that launched them as normal task direction"*.
- A partir de ahí **reconstruye contexto por su cuenta**: tiene Read/Grep/
  Glob/Bash sobre el mismo filesystem, descubre skills del proyecto/usuario/
  plugin vía el Skill tool, y el CLAUDE.md del proyecto se le "siembra" al
  arrancar.
- Excepción: las **"teammates"** (subagentes con `name`, parte de agent-teams)
  sí mantienen pineado el historial del padre mientras viven — modo para
  colaboración sostenida, no para el patrón "delega y listo" que buscamos acá.
- `isolation: "worktree"` crea un **git worktree temporal real**
  (`git worktree add`), no es metáfora.
- Límite de profundidad: 5 niveles de subagentes anidados.
- `run_in_background` default `true`: el orquestador sigue trabajando y se le
  notifica al terminar. La respuesta async trae `agentId`, `outputFile`
  (para leer progreso) y `canReadOutputFile`.

### Empaquetado como plugin

- `.claude-plugin/plugin.json` — manifest (name, version, y punteros a
  `agents`, `hooks`, `mcpServers`, `commands`).
- `agents/*.md` — un archivo por subagente: frontmatter YAML (`name`,
  `description` con bloques `<example>` de disparo, `model`, `color`, `tools`
  opcional) + cuerpo markdown como system prompt.
- `.mcp.json` — servidores MCP a bundlear (stdio/sse/http), con sustitución
  de variables `${CLAUDE_PLUGIN_ROOT}` y `${CLAUDE_PROJECT_DIR}`.
- `hooks/hooks.json` — eventos disponibles: `PreToolUse`, `PostToolUse`,
  `Stop`, `SubagentStop`, `SubagentStart`, `SessionStart`, `UserPromptSubmit`,
  `PreCompact`, `Notification`.

## 3. Mapeo Claude Code nativo → Claucode

| Nativo (Agent tool) | Claucode (hacia OpenCode) |
|---|---|
| `description` | `description` (mismo propósito) |
| `prompt` | `prompt` → mensaje de `opencode run` |
| `subagent_type` | `agent` → flag `--agent` de opencode |
| `model: sonnet\|opus\|haiku` | `model` en formato `provider/model` de opencode (ej. `anthropic/claude-opus-4-6`) — **no son los mismos alias**, opencode tiene su propio namespacing de proveedores |
| `run_in_background: true/false` | tools separadas: una síncrona y un par lanzar/consultar en background (mismo patrón agentId + outputFile del nativo) |
| `isolation: "worktree"` | `isolation: "worktree"` — mismo mecanismo real: git worktree temporal |
| `isolation: "remote"` | sin equivalente (es infraestructura propia de Anthropic) |

CLI real de OpenCode confirmada con `opencode run --help` (no se adivinó):

```
opencode run [message..] --model <provider/model> --agent <nombre>
             --dir <ruta> --format json --file <ruta> --auto
```

## 4. Referencias ya consolidadas (no partir de cero)

### 4.1 `openai/codex-plugin-cc` — el precedente oficial

*"Use Codex from Claude Code to review code or delegate tasks"*. Plugin
**oficial de OpenAI** para delegar desde Claude Code hacia Codex.

- **23,149 estrellas, 1,401 forks, 265 issues abiertos**
- Creado 30 marzo 2026, con push reciente (23 junio 2026) — activamente mantenido
- Prueba de que el patrón "delegar desde Claude Code a otro CLI-agent" está
  validado a gran escala y sancionado por otro laboratorio, no es una idea rara

### 4.2 `tasict/opencode-plugin-cc` — el mismo patrón, pero para OpenCode

Fork/adaptación directa del plugin de OpenAI, reemplazando Codex por OpenCode
(el propio README lo declara: *"inspired by and pays homage to
codex-plugin-cc"*).

**Adopción real: mínima.** 7 estrellas, un solo autor, 6 commits todos el
mismo día (31 marzo 2026, en ~20 minutos), sin actividad de desarrollo desde
entonces. Es funcional pero no tiene tracción — no es "lo que todo el mundo
usa", es la referencia arquitectónica más cercana disponible.

**Qué resuelve bien (y que Claucode debería adoptar o al menos evaluar):**

- **No usa un MCP server que spawnea `opencode run` por cada llamada.** Levanta
  `opencode serve` (servidor HTTP + Server-Sent Events) una sola vez y le habla
  por HTTP. Evita el cold-start de proceso en cada tarea y soporta streaming
  real.
- **Job control real**: comandos `/opencode:status`, `/opencode:result`,
  `/opencode:cancel` sobre jobs en background — más robusto que un simple log
  file.
- **Soporte de sesiones**: `--resume` / `--fresh` para continuar una sesión de
  OpenCode entre llamadas en vez de arrancar de cero cada vez.
- **"Review gate"**: un `Stop` hook que corre una revisión con OpenCode sobre
  la respuesta de Claude y bloquea el stop si encuentra problemas (con
  advertencia explícita de que puede generar loops largos y consumir uso).
- **"Adversarial review"**: modo de revisión que reta activamente decisiones
  de diseño, no solo busca bugs — comando separado de la revisión normal.
- Arquitectura basada en **slash commands + subagente + hooks + companion
  script**, no en tools MCP expuestas — vale la pena comparar ambos enfoques
  antes de decidir (ver sección 5).

Estructura de archivos de referencia (`plugins/opencode/`):

```
.claude-plugin/plugin.json
agents/opencode-rescue.md
commands/{review,adversarial-review,rescue,status,result,cancel,setup}.md
hooks/hooks.json
schemas/review-output.schema.json
scripts/{session-lifecycle-hook,stop-review-gate-hook,opencode-companion}.mjs
prompts/{adversarial-review,stop-review-gate}.md
skills/{opencode-runtime,opencode-result-handling,opencode-prompting}/
```

### 4.3 Ecosistema adyacente (para explorar, no evaluado a fondo aún)

- `wshobson/agents` — 37,483 estrellas — marketplace multi-harness (Claude
  Code, Codex CLI, Cursor, OpenCode, GitHub Copilot). Por su tamaño,
  probablemente ya trae algo de delegación cross-CLI resuelto — pendiente
  revisar si se puede reutilizar o si conviene diferenciarse.
- `unixfox/opencode-claude-code-plugin` — 78 estrellas — dirección inversa
  (usar Claude Code desde OpenCode). No es lo que buscamos, pero confirma que
  la comunidad ya está conectando ambas herramientas en ambos sentidos.

## 5. Decisión de arquitectura pendiente

Hay dos caminos válidos, con tradeoffs distintos:

| | **MCP server** (lo prototipado inicialmente) | **Slash commands + hooks + companion script** (patrón de codex-plugin-cc / opencode-plugin-cc) |
|---|---|---|
| Cómo se invoca | Tools MCP (`opencode_run`, etc.) que Claude llama como cualquier tool | Comandos explícitos (`/opencode:rescue`) + un subagente delgado |
| Proceso OpenCode | Spawnea `opencode run` por cada llamada (cold start) | `opencode serve` persistente, HTTP+SSE (sin cold start, streaming) |
| Background jobs | Manual (log file + polling) | Job control dedicado (status/result/cancel) |
| Sesiones OpenCode | No contempladas en el prototipo inicial | `--resume`/`--fresh` soportado |
| Madurez | Prototipo propio, probado a nivel de handshake MCP | Código ya escrito y funcionando (aunque poco usado) |
| Esfuerzo | Ya hay un esqueleto andando | Requiere leer/adaptar el código de tasict |

**Recomendación de trabajo:** clonar `tasict/opencode-plugin-cc` como base,
auditar `scripts/opencode-companion.mjs` (qué tan sólido es el manejo de
`opencode serve`), y portarle los conceptos que le faltan del contrato nativo:
`isolation: "worktree"` y el mapeo explícito de `subagent_type` → `--agent`.
Si el companion script resulta frágil o insuficiente, se retoma el enfoque MCP
ya prototipado.

## 6. Pendientes / preguntas abiertas

1. ¿MCP server o slash-commands+hooks? (ver sección 5 — pendiente de decidir
   tras auditar el código de tasict).
2. Validar el esquema exacto de `opencode run --format json` /
   `opencode serve` corriendo contra un proveedor real configurado.
3. Definir política de merge para `isolation: "worktree"` — ¿automática con
   confirmación, o siempre manual?
4. Decidir si Claucode debe soportar múltiples backends a futuro (no solo
   OpenCode) — si es así, revisar si conviene un diseño tipo "Janus" (interfaz
   común con adaptadores) desde ahora para no rehacer el mapeo de parámetros.
5. Definir naming final del namespace de comandos/tools (`cloudcode:*` vs
   `opencode:*` como hace la referencia).
6. Decidir si se publica el plugin o queda de uso interno — condiciona si vale
   la pena evitar "Claude"/"Anthropic" literal en nombres de paquete/repo.

## 7. Próximos pasos sugeridos

1. Clonar y leer completo `tasict/opencode-plugin-cc` (especialmente
   `opencode-companion.mjs` y `hooks/hooks.json`).
2. Decidir arquitectura (sección 5).
3. Adaptar/portar el mapeo de la sección 3 sobre la base elegida.
4. Probar end-to-end con un proveedor real configurado en OpenCode.
5. Documentar en README propio de Claucode, siguiendo el mismo formato que
   este documento.
