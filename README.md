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

Pasos:

```bash
# 1. Compilar el server MCP (una vez, desde la raíz del repo)
cd server && npm install && npm run build

# 2. Instalar el plugin en Claude Code (ruta local o repo/marketplace)
claude plugin install <ruta-o-repo-de-opencode-delegate>
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

Config a nivel usuario (`~/.config/opencode-delegate/config.json`) con
override por proyecto (`.opencode-delegate/config.json`):

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

## Verificación E2E (checklist manual — pendiente de ejecución humana)

Requiere una sesión real de Claude Code dentro de un repo git de prueba, con
el plugin instalado (`claude plugin install <ruta-o-repo>`):

1. `/opencode-delegate:run genera un archivo hello.py que imprima hola` →
   devuelve jobId.
2. `/opencode-delegate:status` → muestra acciones (`→ write hello.py`...).
3. `/opencode-delegate:result` → resultado final coherente.
4. Delegación con `isolation: worktree` (pedirle a Claude que use la tool con
   isolation) → verifica rama `opencode-delegate/...` y merge manual.
5. `/opencode-delegate:cancel` sobre un job largo → estado `cancelled`.
6. `/opencode-delegate:cleanup` → worktree eliminado, idempotente al repetir.
7. Cerrar la sesión → verificar con el administrador de tareas que
   `opencode serve` murió (hook).

Documentar cualquier desviación como issue antes de dar por cerrada la v1.

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
