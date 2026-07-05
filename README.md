# opencode-delegate

Plugin de Claude Code para delegar tareas de subagente a modelos gestionados
por [OpenCode](https://opencode.ai), replicando el contrato del Agent tool
nativo. Claude Code sigue siendo el orquestador; tareas mecánicas, búsquedas
amplias, boilerplate y trabajo paralelizable barato pueden ejecutarse en
modelos de OpenCode (incluidos tiers gratuitos) en vez de consumir subagentes
nativos.

```
Claude Code (orquestador)
   │  tools MCP (stdio)
   ▼
opencode-delegate MCP server  (Node.js + TypeScript)
   │  HTTP + SSE
   ▼
opencode serve  (proceso persistente, supervisado por el MCP server)
```

## Instalación

Requisitos:

- Claude Code con soporte de plugins.
- CLI `opencode` instalada y autenticada (`opencode auth login`; verifica con
  `opencode auth list`).
- Node.js 20+.

### Opción A: automática (recomendada)

Desde la raíz del repo clonado (funciona en Windows, macOS y Linux):

```bash
node scripts/install.mjs
```

El script verifica los prerequisitos, compila el server MCP y registra e
instala el plugin en Claude Code.

### Opción B: manual

```bash
# 1. Compilar el server MCP (una vez, desde la raíz del repo)
cd server && npm install && npm run build

# 2. Registrar el repo como marketplace local e instalar el plugin
claude plugin marketplace add <ruta-al-repo-de-opencode-delegate>
claude plugin install opencode-delegate@opencode-delegate
```

Tras instalar, Claude Code levanta el MCP server del plugin automáticamente;
el server lanza y supervisa `opencode serve` bajo demanda. Añade
`.opencode-delegate/` al `.gitignore` del proyecto anfitrión (ahí viven jobs,
logs y el lock del serve).

## Tools

Cinco tools MCP, espejo del Agent tool nativo:

| Tool | Parámetros | Devuelve |
|---|---|---|
| `delegate` | `description` (3-5 palabras), `prompt`, `agent`, `model` (tier o `provider/model`), `run_in_background` (default `true`), `isolation` (`"worktree"` opcional), `timeout_minutes` (default 30) | Background: `jobId` + `outputFile`. Síncrono: resultado final |
| `status` | `jobId` | Estado + últimas acciones formateadas del log |
| `result` | `jobId` | Resultado final (`result.md`); error claro si el job sigue corriendo |
| `cancel` | `jobId` | Aborta el job vía la API de opencode serve, marca `cancelled` |
| `cleanup` | `jobId` opcional (sin él: todos los terminados) | Elimina worktrees/ramas de jobs descartados |

Ejemplo de uso autónomo (Claude decide delegar):

> "Genera los stubs de test para los 12 módulos de utils; usa delegate con
> model light y run_in_background true, y avísame con status cuando termine."

Ejemplo síncrono con aislamiento:

```json
{
  "description": "refactor de imports",
  "prompt": "Ordena y deduplica los imports de src/**/*.ts. No cambies lógica.",
  "model": "light",
  "run_in_background": false,
  "isolation": "worktree",
  "timeout_minutes": 10
}
```

## Comandos

Slash commands delgados que invocan las tools:

| Comando | Ejemplo |
|---|---|
| `/opencode-delegate:run <tarea>` | `/opencode-delegate:run genera un archivo hello.py que imprima hola` |
| `/opencode-delegate:status [jobId]` | `/opencode-delegate:status ocd-abc123-ff00` |
| `/opencode-delegate:result [jobId]` | `/opencode-delegate:result` (usa el último job lanzado) |
| `/opencode-delegate:cancel [jobId]` | `/opencode-delegate:cancel ocd-abc123-ff00` |
| `/opencode-delegate:cleanup [jobId]` | `/opencode-delegate:cleanup` (todos los terminados, con confirmación) |
| `/opencode-delegate:config [set]` | `/opencode-delegate:config` (ver config efectiva) · `config set` (asistente guiado) |

## Subagente delegador

El plugin también registra el subagente `opencode-delegate` (visible en
`/agents`): un wrapper delgado que el Agent tool nativo puede invocar y que
reenvía la tarea a la tool `delegate`. Así el orquestador puede delegar a
OpenCode usando su vocabulario nativo de subagentes, sin instrucciones
adicionales.

## Recomendación para tu CLAUDE.md

Para que Claude delegue de forma proactiva, añade esto al `CLAUDE.md` de tu
proyecto (o al global `~/.claude/CLAUDE.md`) — el instalador ofrece añadirlo
por ti:

```markdown
<!-- opencode-delegate:start -->
## Delegación a OpenCode

Para tareas mecánicas (boilerplate, renombrados masivos, migraciones
repetitivas), búsquedas amplias de código, generación de tests rutinarios y
trabajo paralelizable de bajo riesgo, prefiere delegar a modelos de OpenCode:
usa la tool `delegate` del plugin opencode-delegate o su subagente
`opencode-delegate`. Reserva los subagentes nativos para trabajo que exige
máximo razonamiento (arquitectura, debugging complejo, seguridad).
<!-- opencode-delegate:end -->
```

## Mapeo: Agent tool nativo → opencode-delegate

| Agent tool nativo | opencode-delegate (`delegate`) |
|---|---|
| `description` | `description` |
| `prompt` | `prompt` |
| `subagent_type` | `agent` (flag `--agent` de OpenCode) |
| `model` (`sonnet\|opus\|haiku\|fable`) | `model` (tier `light\|standard\|heavy` o literal `provider/model`) |
| `run_in_background` (default `true`) | `run_in_background` (default `true`) |
| `isolation: "worktree"` | `isolation: "worktree"` (merge siempre manual) |
| `isolation: "remote"` | no soportado (infra propia de Anthropic) |
| `name` / `mode` | no soportado en v1 |
| — | `timeout_minutes` (default 30) |

En background, `delegate` devuelve `jobId` + `outputFile` (apto para
`tail -f`); en síncrono devuelve el resultado final directamente.

## Configuración de modelos

**No se necesita ningún archivo para empezar**: el server trae defaults
compilados (los del ejemplo de abajo). Para personalizar, lo más fácil es
`/opencode-delegate:config set` (asistente guiado que lista tus modelos
disponibles y escribe el archivo por ti); `/opencode-delegate:config` sin
argumentos muestra la config efectiva. Si prefieres editar a mano, las rutas
son estas (el merge es parcial: basta con declarar lo que cambias):

- Nivel usuario: `~/.config/opencode-delegate/config.json`
  (Windows: `C:\Users\<usuario>\.config\opencode-delegate\config.json`)
- Override por proyecto: `.opencode-delegate/config.json` (gana sobre el de
  usuario)

```json
{
  "defaultModel": "opencode-go/glm-5.2",
  "tiers": {
    "light":    "opencode/deepseek-v4-flash-free",
    "standard": "opencode-go/glm-5.2",
    "heavy":    "opencode-go/qwen3.7-max"
  },
  "serve": { "port": 4573, "reuseExisting": true }
}
```

Resolución del parámetro `model`:

- Contiene `/` → se usa literal como `provider/model`.
- Es `light|standard|heavy` → se resuelve por la tabla de tiers.
- Ausente → `defaultModel`.

Los valores del ejemplo reflejan los modelos de la instalación de referencia
(OpenCode Zen); ajústalos a lo que devuelva `opencode models` en la tuya.

## Limitaciones conocidas

- **Visibilidad ≠ vista nativa.** La vista de progreso de subagentes nativos
  de Claude Code no es replicable desde MCP. Se aproxima con el log en vivo
  por job (`output.log`, apto para `tail -f`) y la tool `status`.
- **Merge manual de worktrees.** Con `isolation: "worktree"` nada se integra
  automáticamente: el resultado reporta ruta, rama
  (`opencode-delegate/<jobId>`) y `git diff --stat`; el merge lo decide el
  usuario u orquestador. `cleanup` elimina worktree y rama, y es idempotente.
- **`.opencode-delegate/` al `.gitignore`.** El plugin escribe jobs, logs y
  lock en ese directorio del proyecto anfitrión; añádelo al `.gitignore` (el
  plugin lo sugiere pero no edita tus archivos sin confirmación).
- Proyecto sin git + `isolation: "worktree"` → error explícito, sin fallback.
- Fuera de alcance v1: sesiones OpenCode persistentes (resume), review gate,
  multi-backend, `isolation: "remote"`.
- **Multi-sesión comparte estado.** Dos sesiones de Claude Code trabajando
  sobre el mismo proyecto comparten `.opencode-delegate/` y el mismo
  `opencode serve` (puerto 4573). El hook `SessionEnd` de una sesión puede
  detener el `opencode serve` del que depende un job de la otra sesión,
  provocando un fallo de red/conexión en ese job.
- **Recovery respeta jobs vivos de otras sesiones.** Al arrancar, `recover()`
  solo marca `failed` un job `running` si el proceso dueño (`ownerPid`) ya
  murió; un job cuyo dueño sigue vivo (otra sesión concurrente) se deja
  intacto entre reinicios.

## Troubleshooting

- **`opencode serve` no arranca / la tool falla al primer uso:** revisa
  `.opencode-delegate/serve.log` (ahí van stdout/stderr del serve: errores de
  auth, puerto ocupado, etc.).
- **Errores de autenticación:** verifica `opencode auth list`; sin
  credenciales válidas los modelos no responden.
- **Lock file huérfano tras `/reload-plugins`:** el hook `SessionEnd` mata el
  `opencode serve` propio al cerrar la sesión, pero un `/reload-plugins`
  puede dejar una instancia vieja y su `.opencode-delegate/serve.lock`. Si el
  puerto sigue sano se reutiliza; si no, termina el proceso del PID del lock
  y borra el archivo.
- **Job atascado:** `status <jobId>` muestra las últimas acciones; `cancel`
  aborta la sesión en opencode serve y marca el job `cancelled`. El log
  siempre se preserva.
- **Job atascado en `running` cuya sesión dueña ya murió:** el recovery solo
  corre al arrancar un MCP server; si otra sesión sigue viva no lo tocará.
  Usa `cancel <jobId>` para cerrarlo manualmente.

## Tests

```bash
cd server
npm test              # unit (no requiere opencode)
# integración real (usa el tier "light", modelo free; requiere opencode auth):
OCD_INTEGRATION=1 npx vitest run test/integration.test.ts
```

## Disclaimer

Este proyecto **no está afiliado, patrocinado ni respaldado por Anthropic**
(creadores de Claude y Claude Code) **ni por el proyecto OpenCode / SST**.
"Claude" y "Claude Code" son marcas de Anthropic; "OpenCode" pertenece a sus
respectivos autores. Es una integración independiente de la comunidad; úsala
bajo tu propia responsabilidad y con tus propias credenciales.
