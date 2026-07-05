# opencode-delegate — Diseño consolidado

> Plugin de Claude Code para delegar tareas de subagente a modelos gestionados
> por OpenCode, replicando el contrato del Agent tool nativo.
>
> Estado: **aprobado en brainstorming** (2026-07-04). Sustituye las preguntas
> abiertas de `claucode-spec.md` (documento de investigación previo).

## 1. Decisiones cerradas

| Pendiente del spec original | Decisión |
|---|---|
| ¿MCP server o slash-commands+hooks? | **Híbrido: MCP server propio + `opencode serve` persistente** (HTTP+SSE, sin cold start) |
| ¿Cómo se decide delegar? | **Autónoma + comandos**: descripciones de tools enseñan a Claude cuándo delegar; slash commands para forzarlo |
| Alcance v1 | Delegación síncrona y background con job control + `isolation: "worktree"`. Sin review gate ni sesiones resume (post-v1) |
| Visibilidad del progreso | Log en vivo por job (`output.log`) + tool `status` con últimas acciones. La vista nativa de subagentes no es replicable desde MCP |
| Política de merge (worktree) | **Manual**: se reporta rama/diff y nada se integra sin decisión humana o del orquestador |
| Multi-backend | **Solo OpenCode, sin abstracción** (YAGNI; el mapeo vive en módulo propio, extraer adaptadores después es barato) |
| Distribución | **Publicar desde el inicio** (repo público + marketplace de plugins) |
| Naming | **`opencode-delegate`** (repo, paquete, plugin, namespace de comandos). Nombre neutro sin "Claude"/"Anthropic", siguiendo el patrón de codex-plugin-cc |
| Mapeo de modelos | Config con defaults + tiers (`light|standard|heavy`) + override literal `provider/model` |

## 2. Arquitectura

```
Claude Code (orquestador)
   │  tools MCP (stdio)
   ▼
opencode-delegate MCP server  (Node.js + TypeScript, @modelcontextprotocol/sdk)
   │  HTTP + SSE
   ▼
opencode serve  (proceso persistente, lanzado y supervisado por el MCP server)
```

- El MCP server se bundlea en el plugin vía `.mcp.json` usando
  `${CLAUDE_PLUGIN_ROOT}`.

**Principio rector (resultado de auditoría): disco-primero.** Claude Code
**no reconecta ni reinicia** MCP servers stdio que mueren (a diferencia de
HTTP/SSE, que reintenta con backoff), y hay issues reportados de procesos
stdio terminados inesperadamente. Por tanto:

- El estado en memoria es solo una caché: la fuente de verdad de los jobs son
  los archivos en `.opencode-delegate/jobs/`. Al arrancar, el MCP server
  ejecuta *job recovery*: lee todos los `meta.json` y reconstruye la tabla de
  jobs (marcando como `failed` los `running` cuyo proceso ya no existe si no
  puede readoptarlos vía la API de opencode serve).
- Health check de `opencode serve` **en cada tool call** (no solo la
  primera); si no está vivo, se relanza. Máximo 1 relanzamiento automático
  por llamada; segundo fallo → error accionable.
- **Anti-duplicados:** antes de lanzar `opencode serve`, verificación de
  puerto + lock file (`.opencode-delegate/serve.lock` con PID y puerto). Si
  hay una instancia sana, se reutiliza.
- **Limpieza de huérfanos:** hook `Stop`/`SessionEnd` del plugin que termina
  el `opencode serve` lanzado por esta sesión (identificado por el lock
  file). Documentar que tras `/reload-plugins` puede quedar una instancia
  vieja y cómo limpiarla.
- stdout/stderr de `opencode serve` se capturan en
  `.opencode-delegate/serve.log` — ahí aparecen errores de auth/puerto.

## 3. Superficie de tools (espejo del Agent tool nativo)

| Tool | Parámetros | Devuelve |
|---|---|---|
| `delegate` | `description` (3-5 palabras), `prompt`, `agent` (≙ `subagent_type` → flag `--agent`), `model` (tier o `provider/model`), `run_in_background` (default `true`), `isolation` (`"worktree"` opcional), `timeout_minutes` (default 30) | Background: `jobId` + `outputFile`. Síncrono: resultado final |
| `status` | `jobId` | Estado + últimas N acciones formateadas del log |
| `result` | `jobId` | Resultado final (`result.md`); error claro si el job sigue corriendo |
| `cancel` | `jobId` | Aborta el job vía API de opencode serve, marca `cancelled` |
| `cleanup` | `jobId` opcional (sin él: todos los terminados) | Elimina worktrees/ramas de jobs descartados, con confirmación |

**Slash commands** delgados que invocan las tools:
`/opencode-delegate:run|status|result|cancel|cleanup`.

**Modo síncrono (`run_in_background: false`):** viable pero acotado. El
timeout de tool call MCP es un límite duro de pared configurable por server
(campo `timeout` en `.mcp.json`); el server además emite progress
notifications periódicas durante la ejecución. Tope recomendado del modo
síncrono: el `timeout_minutes` del job, y el `timeout` del server en
`.mcp.json` se fija por encima de ese tope. Para tareas largas, el default
`run_in_background: true` es el camino normal.

**Nota de naming:** en el nombre final de la tool, Claude Code transforma los
caracteres no alfanuméricos, quedando como
`mcp__plugin_opencode_delegate_<server>__delegate` — cosmético, sin impacto.

**Delegación autónoma:** la descripción de `delegate` instruye a Claude a
delegar tareas mecánicas, búsquedas amplias, boilerplate y trabajo
paralelizable barato, manteniendo en subagentes nativos el trabajo que
requiere máxima calidad de razonamiento.

## 4. Jobs y visibilidad

Directorio por job: `.opencode-delegate/jobs/<jobId>/`

- `meta.json` — parámetros de lanzamiento, estado
  (`running|done|failed|cancelled`), timestamps, sessionID de OpenCode, ruta
  del worktree si aplica.
- `output.log` — eventos SSE formateados en vivo (`→ Read src/app.ts`,
  `→ Bash npm test`, fragmentos de texto). Apto para `tail -f` en otra
  terminal.
- `result.md` — respuesta final del agente.

`.opencode-delegate/` se añade al `.gitignore` del proyecto anfitrión (el
plugin lo sugiere; no edita archivos del usuario sin confirmación).

## 5. `isolation: "worktree"`

1. `git worktree add <tmp> -b opencode-delegate/<jobId>` desde HEAD actual.
2. El job corre con `--dir` apuntando al worktree.
3. `result.md` incluye: ruta del worktree, rama, `git diff --stat` resumido.
4. **Merge siempre manual** — decide el orquestador o el usuario.
5. `cleanup` elimina worktree + rama con confirmación. Debe ser idempotente:
   si el usuario ya borró el worktree o la rama a mano, `cleanup` lo registra
   y continúa sin fallar (`git worktree prune` + verificación de existencia).
6. Proyecto sin git + `isolation: "worktree"` → error explícito, sin fallback
   silencioso.

## 6. Mapeo de modelos

Config `opencode-delegate.config.json` — nivel usuario
(`~/.config/opencode-delegate/`) con override por proyecto
(`.opencode-delegate/config.json`):

```json
{
  "defaultModel": "opencode-go/glm-5.2",
  "tiers": {
    "light":    "opencode/deepseek-v4-flash-free",
    "standard": "opencode-go/glm-5.2",
    "heavy":    "opencode-go/qwen3.7-max"
  },
  "serve": { "port": 0, "reuseExisting": true }
}
```

Resolución del parámetro `model`:
- Contiene `/` → se usa literal como `provider/model`.
- Es `light|standard|heavy` → se resuelve por la tabla de tiers.
- Ausente → `defaultModel`.
- Modelo configurado inexistente en `opencode models` → warning explícito en
  la primera llamada (no error fatal: la lista puede variar por auth).

Los valores del ejemplo reflejan los modelos disponibles en la instalación de
referencia (OpenCode Zen); se ajustan por config sin tocar código.

## 7. Manejo de errores

- `opencode serve` caído → health check por llamada + 1 relanzamiento
  automático; segundo fallo → error accionable ("verifica
  `opencode auth list`", puerto ocupado, revisar `serve.log`, etc.).
- Timeout por job (`timeout_minutes`, default 30) → estado `failed`, log
  preservado.
- Validación de parámetros con JSON Schema en el borde MCP.
- Nada de interpolación de strings hacia shell: rutas de worktree y `--dir` se
  construyen con APIs (`child_process.spawn` con array de args).
- Errores del agente delegado (crash del modelo, auth) se reflejan en
  `meta.json` y en el mensaje de la tool, nunca se tragan en silencio.

## 8. Testing

- **Unit (Vitest):** resolución de modelos/tiers, parser de eventos SSE,
  registro de jobs (FS temporal), construcción de worktrees (repo git
  temporal).
- **Integración:** contra `opencode serve` real con modelos `*-free` (sin
  costo): lanzar job, leer SSE, cancelar, timeout.
- **E2E manual:** sesión real de Claude Code con el plugin instalado —
  delegación síncrona, background con `status`/`cancel`, job con worktree.
- Cobertura objetivo: 80% de la lógica del server.

## 9. Estructura del repo

```
opencode-delegate/
├── .claude-plugin/plugin.json
├── .mcp.json
├── hooks/hooks.json                # Stop/SessionEnd: limpieza de opencode serve
├── commands/{run,status,result,cancel,cleanup}.md
├── server/
│   ├── src/
│   │   ├── index.ts          # bootstrap MCP server + registro de tools
│   │   ├── serve-manager.ts  # ciclo de vida de opencode serve
│   │   ├── jobs.ts           # registro/persistencia de jobs
│   │   ├── worktree.ts       # creación/limpieza de worktrees
│   │   ├── models.ts         # resolución tiers/config
│   │   └── sse-parser.ts     # SSE → eventos formateados
│   └── test/
├── docs/superpowers/specs/
└── README.md
```

## 10. Fuera de alcance (v1)

- Sesiones OpenCode persistentes (`--resume`/`--fresh`).
- Review gate / adversarial review (hooks Stop).
- Multi-backend (Codex, Gemini CLI...).
- `isolation: "remote"` (infraestructura propia de Anthropic, sin
  equivalente).
- Réplica exacta de la vista nativa de progreso de subagentes (imposible desde
  MCP; se aproxima con log + `status`).

## 11. Riesgos conocidos

- **BLOCKER — API de `opencode serve` no validada aún** contra la versión
  instalada (1.17.8). El primer paso del plan de implementación es
  obligatoriamente un spike (~2-3 h) que confirme: endpoints HTTP reales,
  formato exacto de eventos SSE (tool calls, texto, errores), cómo cancelar
  un job, y si una sesión puede readoptarse tras reinicio del cliente. Si la
  API difiere de lo asumido, se revisa este diseño antes de implementar.
- **Ciclo de vida stdio (auditado):** Claude Code no reconecta servers stdio
  caídos y puede terminarlos inesperadamente — mitigado por el principio
  disco-primero, job recovery al arrancar, lock file y hook de limpieza
  (sección 2).
- Plugin de referencia (`tasict/opencode-plugin-cc`) tiene adopción mínima;
  se usa como referencia de lectura, no como base de código.
- Publicación pública: revisar lineamientos de marca de Anthropic antes del
  primer release (el nombre neutro ya mitiga lo principal).
