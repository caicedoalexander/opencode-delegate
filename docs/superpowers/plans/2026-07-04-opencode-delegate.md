# opencode-delegate — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plugin de Claude Code que expone tools MCP para delegar tareas de subagente a modelos de OpenCode vía un `opencode serve` persistente, replicando el contrato del Agent tool nativo.

**Architecture:** MCP server stdio en TypeScript (bundleado en el plugin) que supervisa un proceso `opencode serve` (HTTP+SSE). Principio disco-primero: la fuente de verdad de los jobs son archivos en `.opencode-delegate/jobs/`; el estado en memoria es caché reconstruible.

**Tech Stack:** Node.js ≥ 20, TypeScript, `@modelcontextprotocol/sdk`, `zod`, Vitest. Sin frameworks HTTP (se usa `fetch` nativo y `child_process.spawn`).

## Global Constraints (del spec — aplican a TODAS las tareas)

- **Disco-primero:** todo cambio de estado de un job se escribe a `meta.json` ANTES de reflejarse en memoria.
- **Nunca interpolar strings hacia shell:** siempre `spawn`/`execFile` con array de args.
- **Errores nunca se tragan:** todo fallo termina en `meta.json` (`state: "failed"`, campo `error`) y en el mensaje de la tool.
- **Merge de worktrees siempre manual.** Nada se integra automáticamente.
- Cobertura objetivo: 80% de `server/src/` (excluye `index.ts` bootstrap).
- Nombres: plugin/paquete `opencode-delegate`; rama de worktree `opencode-delegate/<jobId>`; dir de estado `.opencode-delegate/`.
- Modelos por defecto (config): `defaultModel: "opencode-go/glm-5.2"`, tiers `light: "opencode/deepseek-v4-flash-free"`, `standard: "opencode-go/glm-5.2"`, `heavy: "opencode-go/qwen3.7-max"`.
- `timeout_minutes` default 30. Timeout MCP del server en `.mcp.json`: 3 900 000 ms (65 min).
- Los detalles de la API HTTP/SSE de opencode son **supuestos hasta la Tarea 1 (spike)**. Los módulos `opencode-client.ts` y `sse-parser.ts` marcan cada supuesto con `// SPIKE:` y la Tarea 1 los corrige contra la realidad.

## Estructura de archivos final

```
opencode-delegate/
├── .claude-plugin/plugin.json        # manifest del plugin
├── .mcp.json                         # registro del MCP server (${CLAUDE_PLUGIN_ROOT})
├── hooks/hooks.json                  # SessionEnd → scripts/stop-serve.mjs
├── scripts/stop-serve.mjs            # mata opencode serve propio (lee lock file)
├── commands/{run,status,result,cancel,cleanup}.md
├── server/
│   ├── package.json / tsconfig.json / vitest.config.ts
│   ├── src/
│   │   ├── index.ts                  # bootstrap MCP + registro de tools
│   │   ├── tools.ts                  # handlers delegate/status/result/cancel/cleanup
│   │   ├── models.ts                 # carga de config + resolución de tiers
│   │   ├── jobs.ts                   # JobStore disco-primero + recovery
│   │   ├── serve-manager.ts          # ciclo de vida de opencode serve + lock file
│   │   ├── opencode-client.ts        # cliente HTTP+SSE de opencode serve
│   │   ├── sse-parser.ts             # eventos SSE → líneas de log legibles
│   │   └── worktree.ts               # git worktree create/diffstat/cleanup
│   └── test/                         # espejo de src/ (*.test.ts)
├── docs/superpowers/specs/…          # ya existe
└── README.md
```

---

### Task 1: Spike — validar la API real de `opencode serve` (BLOCKER)

**Files:**
- Create: `docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md`

**Interfaces:**
- Produces: documento con la forma REAL de: endpoints, body de mensajes, formato SSE, cancelación. Las Tareas 6, 7 y 8 se ajustan con este documento antes de implementarse.

No es TDD: es exploración manual contra el binario instalado (`opencode` 1.17.8).

- [ ] **Step 1: Levantar el server y descubrir la superficie HTTP**

```powershell
# Terminal 1
opencode serve --port 4573
# Terminal 2 — probar los endpoints supuestos y documentar respuesta real:
curl http://localhost:4573/app
curl -X POST http://localhost:4573/session -H "Content-Type: application/json" -d '{}'
```

Si `opencode serve --help` o la doc oficial (`opencode.ai/docs`) exponen un espec OpenAPI (p. ej. `GET /doc`), descargarlo y usarlo como fuente.

- [ ] **Step 2: Enviar un prompt real con un modelo free y capturar el stream SSE**

```powershell
# Con el sessionId del paso anterior:
curl -N http://localhost:4573/event
# En paralelo:
curl -X POST http://localhost:4573/session/<id>/message -H "Content-Type: application/json" `
  -d '{"parts":[{"type":"text","text":"Di hola y nada mas"}],"model":{"providerID":"opencode","modelID":"deepseek-v4-flash-free"}}'
```

Capturar en el documento: nombres de tipos de evento, cómo se identifica el fin de la respuesta, cómo llegan los tool calls (nombre de tool + input), cómo llegan los errores.

- [ ] **Step 3: Validar cancelación, directorio de trabajo y flag agent**

Confirmar: endpoint de abort (¿`POST /session/<id>/abort`?), cómo se fija el directorio de trabajo de una sesión (¿body de `/session`?, ¿query `?directory=`?), y cómo se pasa el agente (¿campo `agent` en el mensaje?).

- [ ] **Step 4: Escribir el documento de hallazgos**

El documento debe tener estas secciones con ejemplos JSON reales copiados de las respuestas: `Endpoints`, `Crear sesión (+directorio)`, `Enviar mensaje (modelo/agent)`, `Formato SSE (tipos de evento con ejemplo real cada uno)`, `Cancelación`, `Health check`, `Desviaciones respecto a los supuestos del plan` (lista explícita de qué corregir en `opencode-client.ts` y `sse-parser.ts`).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-07-04-spike-opencode-serve-api.md
git commit -m "docs: spike de validacion de la API de opencode serve"
```

**Gate:** si la API difiere radicalmente de los supuestos (p. ej. no hay stream SSE consultable), DETENER y revisar el diseño con el usuario antes de continuar.

---

### Task 2: Scaffolding del paquete `server/`

**Files:**
- Create: `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/src/version.ts`, `server/test/version.test.ts`, `.gitignore`

**Interfaces:**
- Produces: comandos `npm test`, `npm run build` funcionando dentro de `server/`.

- [ ] **Step 1: Crear `.gitignore` en la raíz**

```gitignore
node_modules/
server/dist/
.opencode-delegate/
```

- [ ] **Step 2: Crear `server/package.json`**

```json
{
  "name": "opencode-delegate-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@vitest/coverage-v8": "^3.0.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Crear `server/tsconfig.json` y `server/vitest.config.ts`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": false,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/**"], exclude: ["src/index.ts"] },
  },
});
```

- [ ] **Step 4: Test humo + módulo trivial**

`server/test/version.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("expone la version del paquete", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
```

`server/src/version.ts`:

```ts
export const VERSION = "0.1.0";
```

- [ ] **Step 5: Instalar, correr tests y build**

Run: `cd server; npm install; npm test; npm run build`
Expected: 1 test PASS; `dist/version.js` generado.

- [ ] **Step 6: Commit**

```bash
git add .gitignore server
git commit -m "chore: scaffolding del paquete server (TypeScript + Vitest + MCP SDK)"
```

---

### Task 3: `models.ts` — config y resolución de modelos

**Files:**
- Create: `server/src/models.ts`
- Test: `server/test/models.test.ts`

**Interfaces:**
- Produces:
  - `interface DelegateConfig { defaultModel: string; tiers: { light: string; standard: string; heavy: string }; serve: { port: number; reuseExisting: boolean } }`
  - `loadConfig(projectDir: string, homeDir: string): DelegateConfig` — merge: defaults ← `<homeDir>/.config/opencode-delegate/config.json` ← `<projectDir>/.opencode-delegate/config.json` (merge superficial por clave de primer nivel; `tiers` se mergea por tier).
  - `resolveModel(model: string | undefined, config: DelegateConfig): string` — contiene `/` → literal; `light|standard|heavy` → tier; `undefined` → `defaultModel`; otro valor → `throw new Error("Modelo desconocido: ...")`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resolveModel } from "../src/models.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ocd-test-"));
}

describe("resolveModel", () => {
  it("devuelve defaultModel cuando no se pasa modelo", () => {
    expect(resolveModel(undefined, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.defaultModel);
  });

  it("resuelve tiers por tabla", () => {
    expect(resolveModel("light", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.tiers.light);
    expect(resolveModel("heavy", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.tiers.heavy);
  });

  it("acepta provider/model literal sin tocarlo", () => {
    expect(resolveModel("opencode-go/kimi-k2.7-code", DEFAULT_CONFIG)).toBe("opencode-go/kimi-k2.7-code");
  });

  it("lanza error con valor que no es tier ni literal", () => {
    expect(() => resolveModel("turbo", DEFAULT_CONFIG)).toThrow(/Modelo desconocido/);
  });
});

describe("loadConfig", () => {
  it("sin archivos devuelve defaults", () => {
    expect(loadConfig(tempDir(), tempDir())).toEqual(DEFAULT_CONFIG);
  });

  it("config de proyecto pisa la de usuario, que pisa defaults", () => {
    const home = tempDir();
    const project = tempDir();
    mkdirSync(join(home, ".config", "opencode-delegate"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode-delegate", "config.json"),
      JSON.stringify({ defaultModel: "user/model", tiers: { light: "user/light" } }),
    );
    mkdirSync(join(project, ".opencode-delegate"), { recursive: true });
    writeFileSync(
      join(project, ".opencode-delegate", "config.json"),
      JSON.stringify({ defaultModel: "project/model" }),
    );
    const cfg = loadConfig(project, home);
    expect(cfg.defaultModel).toBe("project/model");
    expect(cfg.tiers.light).toBe("user/light");
    expect(cfg.tiers.heavy).toBe(DEFAULT_CONFIG.tiers.heavy);
  });

  it("JSON invalido lanza error con la ruta del archivo", () => {
    const project = tempDir();
    mkdirSync(join(project, ".opencode-delegate"), { recursive: true });
    writeFileSync(join(project, ".opencode-delegate", "config.json"), "{no json");
    expect(() => loadConfig(project, tempDir())).toThrow(/config.json/);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/models.test.ts`
Expected: FAIL — `Cannot find module '../src/models.js'`.

- [ ] **Step 3: Implementar `server/src/models.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DelegateConfig {
  defaultModel: string;
  tiers: { light: string; standard: string; heavy: string };
  serve: { port: number; reuseExisting: boolean };
}

export const DEFAULT_CONFIG: DelegateConfig = {
  defaultModel: "opencode-go/glm-5.2",
  tiers: {
    light: "opencode/deepseek-v4-flash-free",
    standard: "opencode-go/glm-5.2",
    heavy: "opencode-go/qwen3.7-max",
  },
  serve: { port: 4573, reuseExisting: true },
};

const TIERS = ["light", "standard", "heavy"] as const;
type Tier = (typeof TIERS)[number];

function readJsonIfExists(path: string): Partial<DelegateConfig> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<DelegateConfig>;
  } catch (err) {
    throw new Error(`Config invalida en ${path}: ${(err as Error).message}`);
  }
}

function mergeConfig(base: DelegateConfig, over: Partial<DelegateConfig> | undefined): DelegateConfig {
  if (!over) return base;
  return {
    defaultModel: over.defaultModel ?? base.defaultModel,
    tiers: { ...base.tiers, ...(over.tiers ?? {}) },
    serve: { ...base.serve, ...(over.serve ?? {}) },
  };
}

export function loadConfig(projectDir: string, homeDir: string): DelegateConfig {
  const userPath = join(homeDir, ".config", "opencode-delegate", "config.json");
  const projectPath = join(projectDir, ".opencode-delegate", "config.json");
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, readJsonIfExists(userPath)), readJsonIfExists(projectPath));
}

export function resolveModel(model: string | undefined, config: DelegateConfig): string {
  if (model === undefined) return config.defaultModel;
  if (model.includes("/")) return model;
  if ((TIERS as readonly string[]).includes(model)) return config.tiers[model as Tier];
  throw new Error(`Modelo desconocido: "${model}". Usa light|standard|heavy o provider/model.`);
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/models.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/models.ts server/test/models.test.ts
git commit -m "feat: carga de config y resolucion de modelos por tiers"
```

---

### Task 4: `jobs.ts` — JobStore disco-primero con recovery

**Files:**
- Create: `server/src/jobs.ts`
- Test: `server/test/jobs.test.ts`

**Interfaces:**
- Produces:
  - `type JobState = "running" | "done" | "failed" | "cancelled"`
  - `interface JobMeta { id: string; description: string; prompt: string; agent?: string; model: string; isolation?: "worktree"; state: JobState; createdAt: string; finishedAt?: string; opencodeSessionId?: string; worktreePath?: string; branch?: string; error?: string }`
  - `class JobStore` con: `constructor(baseDir: string)` (baseDir = `<proyecto>/.opencode-delegate/jobs`), `createJob(init: Omit<JobMeta, "id" | "state" | "createdAt">): JobMeta`, `writeMeta(meta: JobMeta): void`, `readMeta(id: string): JobMeta`, `appendLog(id: string, line: string): void`, `readLogTail(id: string, n: number): string[]`, `writeResult(id: string, text: string): void`, `readResult(id: string): string`, `list(): JobMeta[]`, `recover(): { markedFailed: string[] }`, `paths(id: string): { dir: string; metaPath: string; logPath: string; resultPath: string }`, `finish(id: string, state: JobState, error?: string): JobMeta`.
- IDs generados: `ocd-<epoch36>-<4 hex aleatorios>`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";

function makeStore(): JobStore {
  return new JobStore(mkdtempSync(join(tmpdir(), "ocd-jobs-")));
}

const INIT = { description: "tarea de prueba", prompt: "haz algo", model: "opencode/deepseek-v4-flash-free" };

describe("JobStore", () => {
  it("createJob persiste meta.json en disco y arranca running", () => {
    const store = makeStore();
    const job = store.createJob(INIT);
    expect(job.id).toMatch(/^ocd-/);
    expect(job.state).toBe("running");
    expect(store.readMeta(job.id)).toEqual(job);
  });

  it("appendLog acumula lineas y readLogTail devuelve las ultimas N", () => {
    const store = makeStore();
    const job = store.createJob(INIT);
    for (let i = 1; i <= 5; i++) store.appendLog(job.id, `linea ${i}`);
    expect(store.readLogTail(job.id, 2)).toEqual(["linea 4", "linea 5"]);
  });

  it("finish marca estado, finishedAt y error", () => {
    const store = makeStore();
    const job = store.createJob(INIT);
    const done = store.finish(job.id, "failed", "boom");
    expect(done.state).toBe("failed");
    expect(done.error).toBe("boom");
    expect(done.finishedAt).toBeDefined();
    expect(store.readMeta(job.id).state).toBe("failed");
  });

  it("writeResult/readResult roundtrip", () => {
    const store = makeStore();
    const job = store.createJob(INIT);
    store.writeResult(job.id, "# listo");
    expect(store.readResult(job.id)).toBe("# listo");
  });

  it("recover marca como failed los jobs running (segunda instancia = post-crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-jobs-"));
    const store1 = new JobStore(dir);
    const running = store1.createJob(INIT);
    const done = store1.createJob(INIT);
    store1.finish(done.id, "done");

    const store2 = new JobStore(dir);
    const { markedFailed } = store2.recover();
    expect(markedFailed).toEqual([running.id]);
    expect(store2.readMeta(running.id).state).toBe("failed");
    expect(store2.readMeta(done.id).state).toBe("done");
  });

  it("readMeta de job inexistente lanza error claro", () => {
    expect(() => makeStore().readMeta("ocd-nope")).toThrow(/no existe/i);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/jobs.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/jobs.ts`**

```ts
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobMeta {
  id: string;
  description: string;
  prompt: string;
  agent?: string;
  model: string;
  isolation?: "worktree";
  state: JobState;
  createdAt: string;
  finishedAt?: string;
  opencodeSessionId?: string;
  worktreePath?: string;
  branch?: string;
  error?: string;
}

export class JobStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  paths(id: string) {
    const dir = join(this.baseDir, id);
    return { dir, metaPath: join(dir, "meta.json"), logPath: join(dir, "output.log"), resultPath: join(dir, "result.md") };
  }

  createJob(init: Omit<JobMeta, "id" | "state" | "createdAt">): JobMeta {
    const id = `ocd-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const meta: JobMeta = { ...init, id, state: "running", createdAt: new Date().toISOString() };
    mkdirSync(this.paths(id).dir, { recursive: true });
    this.writeMeta(meta);
    return meta;
  }

  writeMeta(meta: JobMeta): void {
    writeFileSync(this.paths(meta.id).metaPath, JSON.stringify(meta, null, 2));
  }

  readMeta(id: string): JobMeta {
    const { metaPath } = this.paths(id);
    if (!existsSync(metaPath)) throw new Error(`El job ${id} no existe en ${this.baseDir}`);
    return JSON.parse(readFileSync(metaPath, "utf8")) as JobMeta;
  }

  appendLog(id: string, line: string): void {
    appendFileSync(this.paths(id).logPath, line + "\n");
  }

  readLogTail(id: string, n: number): string[] {
    const { logPath } = this.paths(id);
    if (!existsSync(logPath)) return [];
    const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  }

  writeResult(id: string, text: string): void {
    writeFileSync(this.paths(id).resultPath, text);
  }

  readResult(id: string): string {
    const { resultPath } = this.paths(id);
    if (!existsSync(resultPath)) throw new Error(`El job ${id} no tiene resultado todavia`);
    return readFileSync(resultPath, "utf8");
  }

  list(): JobMeta[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((name) => existsSync(join(this.baseDir, name, "meta.json")))
      .map((name) => this.readMeta(name));
  }

  finish(id: string, state: JobState, error?: string): JobMeta {
    const meta = this.readMeta(id);
    const updated: JobMeta = { ...meta, state, finishedAt: new Date().toISOString(), ...(error ? { error } : {}) };
    this.writeMeta(updated);
    return updated;
  }

  /** Post-arranque: todo job "running" pertenece a un proceso anterior muerto → failed. */
  recover(): { markedFailed: string[] } {
    const markedFailed: string[] = [];
    for (const meta of this.list()) {
      if (meta.state === "running") {
        this.finish(meta.id, "failed", "Interrumpido: el MCP server se reinicio con el job en curso");
        markedFailed.push(meta.id);
      }
    }
    return { markedFailed };
  }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/jobs.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/jobs.ts server/test/jobs.test.ts
git commit -m "feat: JobStore disco-primero con recovery post-crash"
```

---

### Task 5: `sse-parser.ts` — eventos de opencode → líneas de log

**Files:**
- Create: `server/src/sse-parser.ts`
- Test: `server/test/sse-parser.test.ts`

**Interfaces:**
- Consumes: formas de evento documentadas en el spike (Task 1). Las formas de abajo son los supuestos `// SPIKE:` — **ajustar nombres de campos según el documento del spike antes de implementar**.
- Produces:
  - `interface ParsedEvent { kind: "tool" | "text" | "done" | "error" | "other"; line?: string; sessionId?: string; text?: string; errorMessage?: string }`
  - `parseServerEvent(evt: unknown): ParsedEvent` — traduce un evento JSON del stream global de opencode.
  - `parseSseChunk(buffer: string): { events: unknown[]; rest: string }` — parser incremental del wire format SSE (`data: {...}\n\n`), devuelve eventos completos y el resto sin consumir.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
import { describe, expect, it } from "vitest";
import { parseServerEvent, parseSseChunk } from "../src/sse-parser.js";

describe("parseSseChunk", () => {
  it("extrae eventos data: completos y conserva el resto parcial", () => {
    const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"parcial';
    const { events, rest } = parseSseChunk(raw);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(rest).toBe('data: {"parcial');
  });

  it("ignora lineas keepalive/comentario", () => {
    const { events, rest } = parseSseChunk(": ping\n\ndata: {\"a\":1}\n\n");
    expect(events).toEqual([{ a: 1 }]);
    expect(rest).toBe("");
  });
});

// SPIKE: las formas de evento de abajo se corrigen con el doc del spike.
describe("parseServerEvent", () => {
  it("tool call -> linea con flecha, tool y resumen del input", () => {
    const evt = {
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses_1",
          type: "tool",
          tool: "read",
          state: { status: "running", input: { filePath: "src/app.ts" } },
        },
      },
    };
    const parsed = parseServerEvent(evt);
    expect(parsed.kind).toBe("tool");
    expect(parsed.sessionId).toBe("ses_1");
    expect(parsed.line).toBe("→ read src/app.ts");
  });

  it("texto del asistente -> kind text con el fragmento", () => {
    const evt = {
      type: "message.part.updated",
      properties: { part: { sessionID: "ses_1", type: "text", text: "Hola" } },
    };
    const parsed = parseServerEvent(evt);
    expect(parsed.kind).toBe("text");
    expect(parsed.text).toBe("Hola");
  });

  it("session idle -> kind done", () => {
    const evt = { type: "session.idle", properties: { sessionID: "ses_1" } };
    expect(parseServerEvent(evt)).toMatchObject({ kind: "done", sessionId: "ses_1" });
  });

  it("session error -> kind error con mensaje", () => {
    const evt = { type: "session.error", properties: { sessionID: "ses_1", error: { message: "auth expirada" } } };
    expect(parseServerEvent(evt)).toMatchObject({ kind: "error", sessionId: "ses_1", errorMessage: "auth expirada" });
  });

  it("evento desconocido -> kind other sin romper", () => {
    expect(parseServerEvent({ type: "server.heartbeat" }).kind).toBe("other");
    expect(parseServerEvent(null).kind).toBe("other");
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/sse-parser.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/sse-parser.ts`**

```ts
export interface ParsedEvent {
  kind: "tool" | "text" | "done" | "error" | "other";
  line?: string;
  sessionId?: string;
  text?: string;
  errorMessage?: string;
}

/** Parser incremental del wire format SSE: devuelve JSONs completos + resto sin consumir. */
export function parseSseChunk(buffer: string): { events: unknown[]; rest: string } {
  const events: unknown[] = [];
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data: ")) continue; // ignora ": ping" y campos event:/id:
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        // data no-JSON: se ignora, el log de serve captura el crudo
      }
    }
  }
  return { events, rest };
}

function summarizeInput(input: unknown): string {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    // SPIKE: claves de input mas comunes segun el spike (filePath, command, pattern…)
    for (const key of ["filePath", "path", "command", "pattern", "url", "description"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
  }
  return "";
}

// SPIKE: nombres de type/campos supuestos — corregir contra el doc del spike (Task 1).
export function parseServerEvent(evt: unknown): ParsedEvent {
  if (!evt || typeof evt !== "object") return { kind: "other" };
  const e = evt as { type?: string; properties?: Record<string, unknown> };
  const props = e.properties ?? {};

  if (e.type === "message.part.updated") {
    const part = props.part as
      | { sessionID?: string; type?: string; tool?: string; text?: string; state?: { status?: string; input?: unknown } }
      | undefined;
    if (!part) return { kind: "other" };
    if (part.type === "tool" && part.state?.status === "running") {
      const summary = summarizeInput(part.state.input);
      return {
        kind: "tool",
        sessionId: part.sessionID,
        line: `→ ${part.tool ?? "tool"}${summary ? " " + summary : ""}`,
      };
    }
    if (part.type === "text" && typeof part.text === "string") {
      return { kind: "text", sessionId: part.sessionID, text: part.text };
    }
    return { kind: "other" };
  }

  if (e.type === "session.idle") {
    return { kind: "done", sessionId: props.sessionID as string | undefined };
  }

  if (e.type === "session.error") {
    const error = props.error as { message?: string } | undefined;
    return {
      kind: "error",
      sessionId: props.sessionID as string | undefined,
      errorMessage: error?.message ?? "error desconocido de opencode",
    };
  }

  return { kind: "other" };
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/sse-parser.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/sse-parser.ts server/test/sse-parser.test.ts
git commit -m "feat: parser SSE incremental y traduccion de eventos a log legible"
```

---

### Task 6: `serve-manager.ts` — ciclo de vida de `opencode serve`

**Files:**
- Create: `server/src/serve-manager.ts`
- Test: `server/test/serve-manager.test.ts`

**Interfaces:**
- Consumes: endpoint de health confirmado por el spike (supuesto: `GET /app` → 200).
- Produces:
  - `interface ServeInfo { baseUrl: string; pid: number; ownedByUs: boolean }`
  - `class ServeManager` con `constructor(opts: { stateDir: string; port: number; reuseExisting: boolean; opencodeBin?: string })`, `async ensureRunning(): Promise<ServeInfo>`, `async stopIfOwned(): Promise<void>`, `lockPath: string` (= `<stateDir>/serve.lock`, JSON `{ pid, port, startedAt }`), log en `<stateDir>/serve.log`.
- Reglas: health check contra `http://127.0.0.1:<port>/app` con timeout 2 s; si sano → reutilizar (`ownedByUs: false` si el lock no es nuestro o no existe); si no → spawn de `opencodeBin ?? "opencode"` con args `["serve", "--port", String(port)]`, stdout+stderr a `serve.log`, escribir lock, poll de health cada 250 ms hasta 15 s; si no arranca → matar el proceso y lanzar error accionable que mencione `serve.log`.

- [ ] **Step 1: Escribir los tests que fallan**

Testeamos la lógica de reuse/health con un servidor HTTP real de Node en puerto efímero, y el spawn con un binario fake (script Node que abre un server HTTP). Sin mocks de red.

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ServeManager } from "../src/serve-manager.js";

let servers: Server[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  return new Promise((resolve) => {
    const srv = createServer(handler);
    servers.push(srv);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as { port: number }).port));
  });
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "ocd-serve-"));
}

describe("ServeManager.ensureRunning", () => {
  it("reutiliza un serve sano existente sin spawnear", async () => {
    const port = await listen((_req, res) => res.writeHead(200).end("{}"));
    const mgr = new ServeManager({ stateDir: stateDir(), port, reuseExisting: true, opencodeBin: "no-existe" });
    const info = await mgr.ensureRunning();
    expect(info.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(info.ownedByUs).toBe(false);
  });

  it("spawnea el binario cuando no hay serve y escribe el lock", async () => {
    const dir = stateDir();
    // binario fake: node <script> serve --port N -> abre HTTP 200 en N
    const fake = join(dir, "fake-serve.mjs");
    writeFileSync(
      fake,
      `import { createServer } from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
createServer((_q, r) => r.writeHead(200).end("{}")).listen(port, "127.0.0.1");
setInterval(() => {}, 1000);`,
    );
    const port = 40000 + Math.floor(Math.random() * 10000);
    const mgr = new ServeManager({
      stateDir: dir,
      port,
      reuseExisting: true,
      opencodeBin: process.execPath, // node
      extraArgsPrefix: [fake],       // node fake-serve.mjs serve --port N
    });
    const info = await mgr.ensureRunning();
    expect(info.ownedByUs).toBe(true);
    const lock = JSON.parse(readFileSync(mgr.lockPath, "utf8"));
    expect(lock.port).toBe(port);
    expect(lock.pid).toBe(info.pid);
    await mgr.stopIfOwned();
  }, 20000);

  it("falla con error accionable si el binario no levanta", async () => {
    const dir = stateDir();
    const mgr = new ServeManager({
      stateDir: dir,
      port: 40000 + Math.floor(Math.random() * 10000),
      reuseExisting: true,
      opencodeBin: process.execPath,
      extraArgsPrefix: ["-e", "process.exit(1)"],
      startupTimeoutMs: 1500,
    });
    await expect(mgr.ensureRunning()).rejects.toThrow(/serve\.log/);
  }, 20000);
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/serve-manager.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/serve-manager.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export interface ServeInfo {
  baseUrl: string;
  pid: number;
  ownedByUs: boolean;
}

interface ServeManagerOptions {
  stateDir: string;
  port: number;
  reuseExisting: boolean;
  opencodeBin?: string;
  /** Solo para tests: args que van ANTES de "serve" (p. ej. ruta de un script fake). */
  extraArgsPrefix?: string[];
  startupTimeoutMs?: number;
}

export class ServeManager {
  readonly lockPath: string;
  private readonly logPath: string;
  private child: ChildProcess | undefined;

  constructor(private readonly opts: ServeManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.lockPath = join(opts.stateDir, "serve.lock");
    this.logPath = join(opts.stateDir, "serve.log");
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  // SPIKE: endpoint de health supuesto GET /app — confirmar en Task 1.
  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/app`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<ServeInfo> {
    if (this.opts.reuseExisting && (await this.isHealthy())) {
      const lock = this.readLock();
      return { baseUrl: this.baseUrl(), pid: lock?.pid ?? -1, ownedByUs: this.child !== undefined };
    }
    return this.spawnServe();
  }

  private readLock(): { pid: number; port: number } | undefined {
    if (!existsSync(this.lockPath)) return undefined;
    try {
      return JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid: number; port: number };
    } catch {
      return undefined;
    }
  }

  private async spawnServe(): Promise<ServeInfo> {
    const bin = this.opts.opencodeBin ?? "opencode";
    const args = [...(this.opts.extraArgsPrefix ?? []), "serve", "--port", String(this.opts.port)];
    const logFd = openSync(this.logPath, "a");
    const child = spawn(bin, args, { stdio: ["ignore", logFd, logFd] });
    this.child = child;
    writeFileSync(this.lockPath, JSON.stringify({ pid: child.pid, port: this.opts.port, startedAt: new Date().toISOString() }));

    const deadline = Date.now() + (this.opts.startupTimeoutMs ?? 15000);
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      if (await this.isHealthy()) {
        return { baseUrl: this.baseUrl(), pid: child.pid ?? -1, ownedByUs: true };
      }
      await sleep(250);
    }
    child.kill();
    this.child = undefined;
    rmSync(this.lockPath, { force: true });
    throw new Error(
      `opencode serve no respondio en el puerto ${this.opts.port}. Revisa ${this.logPath}, ` +
        `verifica \`opencode auth list\` y que el puerto este libre.`,
    );
  }

  async stopIfOwned(): Promise<void> {
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
      this.child = undefined;
    }
    rmSync(this.lockPath, { force: true });
  }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/serve-manager.test.ts`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/serve-manager.ts server/test/serve-manager.test.ts
git commit -m "feat: ServeManager con lock file, reuse, spawn supervisado y serve.log"
```

---

### Task 7: `opencode-client.ts` — cliente HTTP+SSE

**Files:**
- Create: `server/src/opencode-client.ts`
- Test: `server/test/opencode-client.test.ts`

**Interfaces:**
- Consumes: endpoints confirmados por el spike (Task 1). Supuestos `// SPIKE:`: `POST /session` (body `{ directory? }`) → `{ id }`; `POST /session/:id/message` (body `{ parts: [{type:"text",text}], model: {providerID, modelID}, agent? }`); `POST /session/:id/abort`; `GET /event` (SSE global).
- Produces:
  - `splitModel(model: string): { providerID: string; modelID: string }` — divide por la PRIMERA `/`.
  - `class OpencodeClient` con `constructor(baseUrl: string)`, `async createSession(directory?: string): Promise<string>` (devuelve id), `async sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<void>`, `async abort(sessionId: string): Promise<void>`, `subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void>` (consume `GET /event` usando `parseSseChunk`; la promesa resuelve al abortar el signal y rechaza en error de red).

- [ ] **Step 1: Escribir los tests que fallan**

Con un servidor HTTP real de Node que graba requests y emite SSE:

```ts
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OpencodeClient, splitModel } from "../src/opencode-client.js";

let server: Server | undefined;
afterEach(() => server?.close());

interface Recorded { method: string; url: string; body: string }

function startFake(requests: Recorded[], onEventStream?: (res: import("node:http").ServerResponse) => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: req.method ?? "", url: req.url ?? "", body });
        if (req.url === "/event" && onEventStream) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          onEventStream(res);
          return;
        }
        if (req.url === "/session" && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "ses_test" }));
          return;
        }
        res.writeHead(200).end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
  });
}

describe("splitModel", () => {
  it("divide provider/model por la primera barra", () => {
    expect(splitModel("opencode-go/glm-5.2")).toEqual({ providerID: "opencode-go", modelID: "glm-5.2" });
    expect(splitModel("a/b/c")).toEqual({ providerID: "a", modelID: "b/c" });
  });
  it("lanza si no hay barra", () => {
    expect(() => splitModel("glm")).toThrow(/provider\/model/);
  });
});

describe("OpencodeClient", () => {
  it("createSession manda directory y devuelve el id", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    const id = await client.createSession("C:\\repo");
    expect(id).toBe("ses_test");
    expect(reqs[0]).toMatchObject({ method: "POST", url: "/session" });
    expect(JSON.parse(reqs[0].body)).toEqual({ directory: "C:\\repo" });
  });

  it("sendMessage arma parts + model + agent", async () => {
    const reqs: Recorded[] = [];
    const client = new OpencodeClient(await startFake(reqs));
    await client.sendMessage("ses_test", "hola", "opencode-go/glm-5.2", "reviewer");
    const msg = reqs.find((r) => r.url === "/session/ses_test/message");
    expect(msg).toBeDefined();
    expect(JSON.parse(msg!.body)).toEqual({
      parts: [{ type: "text", text: "hola" }],
      model: { providerID: "opencode-go", modelID: "glm-5.2" },
      agent: "reviewer",
    });
  });

  it("subscribe entrega eventos parseados y termina al abortar", async () => {
    const reqs: Recorded[] = [];
    const base = await startFake(reqs, (res) => {
      res.write('data: {"type":"session.idle","properties":{"sessionID":"ses_test"}}\n\n');
    });
    const client = new OpencodeClient(base);
    const events: unknown[] = [];
    const ctrl = new AbortController();
    const sub = client.subscribe((e) => {
      events.push(e);
      ctrl.abort();
    }, ctrl.signal);
    await sub;
    expect(events).toEqual([{ type: "session.idle", properties: { sessionID: "ses_test" } }]);
  });

  it("respuesta no-2xx lanza error con status y cuerpo", async () => {
    const reqs: Recorded[] = [];
    server?.close();
    const base = await new Promise<string>((resolve) => {
      server = createServer((_req, res) => res.writeHead(500).end("kaput"));
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    });
    const client = new OpencodeClient(base);
    await expect(client.createSession()).rejects.toThrow(/500.*kaput/s);
    void reqs;
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/opencode-client.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/opencode-client.ts`**

```ts
import { parseSseChunk } from "./sse-parser.js";

export function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx <= 0) throw new Error(`Modelo "${model}" invalido: se espera formato provider/model`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

// SPIKE: rutas y bodies supuestos — corregir contra el doc del spike (Task 1).
export class OpencodeClient {
  constructor(private readonly baseUrl: string) {}

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`opencode serve respondio ${res.status} en ${path}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  async createSession(directory?: string): Promise<string> {
    const data = (await this.post("/session", directory ? { directory } : {})) as { id?: string };
    if (!data.id) throw new Error("POST /session no devolvio un id de sesion");
    return data.id;
  }

  async sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<void> {
    await this.post(`/session/${sessionId}/message`, {
      parts: [{ type: "text", text }],
      model: splitModel(model),
      ...(agent ? { agent } : {}),
    });
  }

  async abort(sessionId: string): Promise<void> {
    await this.post(`/session/${sessionId}/abort`, {});
  }

  async subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void> {
    const res = await fetch(this.baseUrl + "/event", { signal });
    if (!res.ok || !res.body) throw new Error(`GET /event respondio ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const evt of events) onEvent(evt);
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/opencode-client.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/opencode-client.ts server/test/opencode-client.test.ts
git commit -m "feat: cliente HTTP+SSE de opencode serve"
```

---

### Task 8: `worktree.ts` — aislamiento en git worktrees

**Files:**
- Create: `server/src/worktree.ts`
- Test: `server/test/worktree.test.ts`

**Interfaces:**
- Produces:
  - `async createWorktree(repoDir: string, jobId: string): Promise<{ path: string; branch: string }>` — rama `opencode-delegate/<jobId>`, worktree en `<repoDir>/.opencode-delegate/worktrees/<jobId>`; si `repoDir` no es repo git → `throw` con mensaje que incluya "no es un repositorio git".
  - `async diffStat(worktreePath: string): Promise<string>` — `git -C <path> diff --stat HEAD` + `git -C <path> status --short` concatenados (cubre archivos nuevos sin commitear).
  - `async removeWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void>` — idempotente: `git worktree remove --force` si existe, `git worktree prune`, `git branch -D` si existe; nunca lanza por "ya no existe".
- Todo con `execFile` (promisificado) y arrays de args. Sin `shell: true`.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorktree, diffStat, removeWorktree } from "../src/worktree.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocd-repo-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init");
  git("config", "user.email", "t@t.local");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "hola");
  git("add", ".");
  git("commit", "-m", "init");
  return dir;
}

describe("worktree", () => {
  it("createWorktree crea rama y directorio desde HEAD", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ocd-x1");
    expect(wt.branch).toBe("opencode-delegate/ocd-x1");
    expect(existsSync(join(wt.path, "a.txt"))).toBe(true);
  });

  it("falla claro si el directorio no es un repo git", async () => {
    const noRepo = mkdtempSync(join(tmpdir(), "ocd-norepo-"));
    await expect(createWorktree(noRepo, "ocd-x2")).rejects.toThrow(/no es un repositorio git/);
  });

  it("diffStat refleja archivos nuevos y modificados en el worktree", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ocd-x3");
    writeFileSync(join(wt.path, "nuevo.txt"), "x");
    const stat = await diffStat(wt.path);
    expect(stat).toContain("nuevo.txt");
  });

  it("removeWorktree es idempotente (doble llamada no lanza)", async () => {
    const repo = makeRepo();
    const wt = await createWorktree(repo, "ocd-x4");
    await removeWorktree(repo, wt.path, wt.branch);
    expect(existsSync(wt.path)).toBe(false);
    await expect(removeWorktree(repo, wt.path, wt.branch)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/worktree.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/worktree.ts`**

```ts
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwdRepo: string, ...args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", cwdRepo, ...args]);
  return stdout;
}

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, "rev-parse", "--git-dir");
    return true;
  } catch {
    return false;
  }
}

export async function createWorktree(repoDir: string, jobId: string): Promise<{ path: string; branch: string }> {
  if (!(await isGitRepo(repoDir))) {
    throw new Error(`isolation "worktree" requiere git: ${repoDir} no es un repositorio git`);
  }
  const branch = `opencode-delegate/${jobId}`;
  const base = join(repoDir, ".opencode-delegate", "worktrees");
  mkdirSync(base, { recursive: true });
  const path = join(base, jobId);
  await git(repoDir, "worktree", "add", path, "-b", branch);
  return { path, branch };
}

export async function diffStat(worktreePath: string): Promise<string> {
  const stat = await git(worktreePath, "diff", "--stat", "HEAD");
  const status = await git(worktreePath, "status", "--short");
  return [stat.trim(), status.trim()].filter(Boolean).join("\n");
}

export async function removeWorktree(repoDir: string, worktreePath: string, branch: string): Promise<void> {
  if (existsSync(worktreePath)) {
    try {
      await git(repoDir, "worktree", "remove", "--force", worktreePath);
    } catch {
      // ya eliminado a mano o corrupto: prune se encarga
    }
  }
  await git(repoDir, "worktree", "prune");
  try {
    await git(repoDir, "branch", "-D", branch);
  } catch {
    // la rama ya no existe: idempotencia
  }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/worktree.test.ts`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/worktree.ts server/test/worktree.test.ts
git commit -m "feat: creacion, diffstat y limpieza idempotente de git worktrees"
```

---

### Task 9: `tools.ts` — orquestación de las 5 tools

**Files:**
- Create: `server/src/tools.ts`
- Test: `server/test/tools.test.ts`

**Interfaces:**
- Consumes: `JobStore` (Task 4), `resolveModel`/`DelegateConfig` (Task 3), `parseServerEvent` (Task 5), `ServeManager` (Task 6), `OpencodeClient` (Task 7), `createWorktree`/`diffStat`/`removeWorktree` (Task 8).
- Produces (lo que registra `index.ts` en Task 10):

```ts
export interface ToolDeps {
  projectDir: string;
  config: DelegateConfig;
  jobs: JobStore;
  serve: ServeManager;
  clientFactory: (baseUrl: string) => OpencodeClientLike; // inyectable en tests
}
export interface OpencodeClientLike {
  createSession(directory?: string): Promise<string>;
  sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void>;
}
export interface DelegateParams {
  description: string; prompt: string; agent?: string; model?: string;
  run_in_background?: boolean; isolation?: "worktree"; timeout_minutes?: number;
}
export async function delegateTool(params: DelegateParams, deps: ToolDeps): Promise<string>;
export async function statusTool(params: { jobId: string }, deps: ToolDeps): Promise<string>;
export async function resultTool(params: { jobId: string }, deps: ToolDeps): Promise<string>;
export async function cancelTool(params: { jobId: string }, deps: ToolDeps): Promise<string>;
export async function cleanupTool(params: { jobId?: string }, deps: ToolDeps): Promise<string>;
```

**Flujo de `delegateTool`:**
1. `resolveModel` → si `isolation:"worktree"`, `createWorktree` (si falla, el job nace y muere `failed` con el error).
2. `jobs.createJob` → `serve.ensureRunning()` → `client.createSession(worktree ?? projectDir)` → guardar `opencodeSessionId` en meta → `client.sendMessage(...)`.
3. Lanzar (sin await en background) `runJobLoop`: `client.subscribe` filtrando por `sessionId`; cada `kind:"tool"` → `jobs.appendLog(line)`; `kind:"text"` → acumular en `resultText` (y appendLog de la primera línea de cada fragmento con prefijo `· `); `kind:"done"` → `writeResult(resultText)`, `finish("done")`, abort del subscribe; `kind:"error"` → `finish("failed", msg)`, abort. Timeout: `setTimeout` de `timeout_minutes*60_000` → `client.abort(sessionId)` + `finish("failed", "Timeout tras N minutos")`.
4. Background (default): devolver de inmediato `jobId`, `outputFile` (logPath) y cómo consultar. Síncrono: `await` del loop y devolver el resultado final (+ diffstat y rama si hubo worktree).

- [ ] **Step 1: Escribir los tests que fallan**

Cliente fake controlable por el test (sin red, sin binarios):

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { DEFAULT_CONFIG } from "../src/models.js";
import type { OpencodeClientLike, ToolDeps } from "../src/tools.js";
import { cancelTool, delegateTool, resultTool, statusTool } from "../src/tools.js";

class FakeClient implements OpencodeClientLike {
  aborted: string[] = [];
  private listeners: Array<(evt: unknown) => void> = [];
  async createSession(): Promise<string> { return "ses_fake"; }
  async sendMessage(): Promise<void> {}
  async abort(sessionId: string): Promise<void> { this.aborted.push(sessionId); }
  async subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void> {
    this.listeners.push(onEvent);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  }
  emit(evt: unknown): void { for (const l of this.listeners) l(evt); }
}

function makeDeps(client: FakeClient): ToolDeps {
  const projectDir = mkdtempSync(join(tmpdir(), "ocd-tools-"));
  return {
    projectDir,
    config: DEFAULT_CONFIG,
    jobs: new JobStore(join(projectDir, ".opencode-delegate", "jobs")),
    serve: { ensureRunning: async () => ({ baseUrl: "http://fake", pid: 1, ownedByUs: true }) } as ToolDeps["serve"],
    clientFactory: () => client,
  };
}

const PARAMS = { description: "probar tools", prompt: "haz X" };

function idle(sessionId = "ses_fake") {
  return { type: "session.idle", properties: { sessionID: sessionId } };
}
function text(t: string, sessionId = "ses_fake") {
  return { type: "message.part.updated", properties: { part: { sessionID: sessionId, type: "text", text: t } } };
}
function toolEvt(sessionId = "ses_fake") {
  return {
    type: "message.part.updated",
    properties: { part: { sessionID: sessionId, type: "tool", tool: "read", state: { status: "running", input: { filePath: "a.ts" } } } },
  };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("delegateTool background (default)", () => {
  it("devuelve jobId + outputFile de inmediato y el job termina done al llegar session.idle", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    expect(out).toContain("output.log");
    await tick();
    client.emit(text("resultado parcial"));
    client.emit(idle());
    await tick();
    const meta = deps.jobs.readMeta(jobId);
    expect(meta.state).toBe("done");
    expect(deps.jobs.readResult(jobId)).toContain("resultado parcial");
  });

  it("ignora eventos de otras sesiones", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    await tick();
    client.emit(idle("ses_OTRA"));
    await tick();
    expect(deps.jobs.readMeta(jobId).state).toBe("running");
    client.emit(idle());
    await tick();
    expect(deps.jobs.readMeta(jobId).state).toBe("done");
  });

  it("session.error marca el job failed con el mensaje", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    await tick();
    client.emit({ type: "session.error", properties: { sessionID: "ses_fake", error: { message: "sin creditos" } } });
    await tick();
    const meta = deps.jobs.readMeta(jobId);
    expect(meta.state).toBe("failed");
    expect(meta.error).toContain("sin creditos");
  });
});

describe("delegateTool sincrono", () => {
  it("espera el resultado y lo devuelve en el mensaje", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const pending = delegateTool({ ...PARAMS, run_in_background: false }, deps);
    await tick();
    client.emit(text("todo listo"));
    client.emit(idle());
    const out = await pending;
    expect(out).toContain("todo listo");
  });

  it("timeout marca failed y aborta la sesion", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool({ ...PARAMS, run_in_background: false, timeout_minutes: 0.001 }, deps).catch((e: Error) => e.message);
    expect(out).toMatch(/[Tt]imeout/);
    expect(client.aborted).toContain("ses_fake");
  });
});

describe("statusTool / resultTool / cancelTool", () => {
  it("status muestra estado y ultimas acciones del log", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    await tick();
    client.emit(toolEvt());
    await tick();
    const status = await statusTool({ jobId }, deps);
    expect(status).toContain("running");
    expect(status).toContain("→ read a.ts");
  });

  it("result falla claro si el job sigue corriendo", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    await expect(resultTool({ jobId }, deps)).rejects.toThrow(/sigue corriendo|running/i);
  });

  it("cancel aborta la sesion y marca cancelled", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = /ocd-[a-z0-9-]+/.exec(out)![0];
    await tick();
    const msg = await cancelTool({ jobId }, deps);
    expect(msg).toContain(jobId);
    expect(client.aborted).toContain("ses_fake");
    expect(deps.jobs.readMeta(jobId).state).toBe("cancelled");
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server; npx vitest run test/tools.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar `server/src/tools.ts`**

```ts
import { join } from "node:path";
import type { JobMeta, JobStore } from "./jobs.js";
import type { DelegateConfig } from "./models.js";
import { resolveModel } from "./models.js";
import { parseServerEvent } from "./sse-parser.js";
import type { ServeManager } from "./serve-manager.js";
import { createWorktree, diffStat, removeWorktree } from "./worktree.js";

export interface OpencodeClientLike {
  createSession(directory?: string): Promise<string>;
  sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<void>;
  abort(sessionId: string): Promise<void>;
  subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void>;
}

export interface ToolDeps {
  projectDir: string;
  config: DelegateConfig;
  jobs: JobStore;
  serve: Pick<ServeManager, "ensureRunning">;
  clientFactory: (baseUrl: string) => OpencodeClientLike;
}

export interface DelegateParams {
  description: string;
  prompt: string;
  agent?: string;
  model?: string;
  run_in_background?: boolean;
  isolation?: "worktree";
  timeout_minutes?: number;
}

const DEFAULT_TIMEOUT_MINUTES = 30;
const STATUS_TAIL_LINES = 15;

interface JobOutcome {
  meta: JobMeta;
  resultText: string;
}

async function runJobLoop(
  job: JobMeta,
  client: OpencodeClientLike,
  deps: ToolDeps,
  timeoutMinutes: number,
): Promise<JobOutcome> {
  const sessionId = job.opencodeSessionId!;
  const ctrl = new AbortController();
  let resultText = "";
  let outcome: { state: "done" | "failed"; error?: string } | undefined;

  const timer = setTimeout(() => {
    outcome = { state: "failed", error: `Timeout tras ${timeoutMinutes} minutos` };
    void client.abort(sessionId).catch(() => {});
    ctrl.abort();
  }, timeoutMinutes * 60_000);

  await client.subscribe((evt) => {
    const parsed = parseServerEvent(evt);
    if (parsed.sessionId !== sessionId) return;
    if (parsed.kind === "tool" && parsed.line) deps.jobs.appendLog(job.id, parsed.line);
    if (parsed.kind === "text" && parsed.text) resultText += parsed.text;
    if (parsed.kind === "done") {
      outcome = { state: "done" };
      ctrl.abort();
    }
    if (parsed.kind === "error") {
      outcome = { state: "failed", error: parsed.errorMessage };
      ctrl.abort();
    }
  }, ctrl.signal);

  clearTimeout(timer);
  const finalState = outcome ?? { state: "failed" as const, error: "Stream de eventos terminado sin resultado" };

  // No pisar un estado terminal escrito por cancelTool mientras corriamos.
  const current = deps.jobs.readMeta(job.id);
  if (current.state !== "running") return { meta: current, resultText };

  if (finalState.state === "done") {
    let finalText = resultText.trim() || "(el agente termino sin texto de respuesta)";
    if (current.worktreePath && current.branch) {
      const stat = await diffStat(current.worktreePath).catch((e: Error) => `(diffstat fallo: ${e.message})`);
      finalText += `\n\n---\nWorktree: ${current.worktreePath}\nRama: ${current.branch}\nCambios:\n${stat || "(sin cambios)"}`;
    }
    deps.jobs.writeResult(job.id, finalText);
    const meta = deps.jobs.finish(job.id, "done");
    return { meta, resultText: finalText };
  }
  const meta = deps.jobs.finish(job.id, "failed", finalState.error);
  return { meta, resultText };
}

export async function delegateTool(params: DelegateParams, deps: ToolDeps): Promise<string> {
  const model = resolveModel(params.model, deps.config);
  const background = params.run_in_background !== false;
  const timeoutMinutes = params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES;

  let worktree: { path: string; branch: string } | undefined;
  if (params.isolation === "worktree") {
    worktree = await createWorktree(deps.projectDir, `pre-${Date.now().toString(36)}`);
  }

  const job = deps.jobs.createJob({
    description: params.description,
    prompt: params.prompt,
    agent: params.agent,
    model,
    isolation: params.isolation,
    worktreePath: worktree?.path,
    branch: worktree?.branch,
  });
  deps.jobs.appendLog(job.id, `[${job.createdAt}] job ${job.id} (${model}) — ${params.description}`);

  try {
    const serve = await deps.serve.ensureRunning();
    const client = deps.clientFactory(serve.baseUrl);
    const sessionId = await client.createSession(worktree?.path ?? deps.projectDir);
    const withSession: JobMeta = { ...deps.jobs.readMeta(job.id), opencodeSessionId: sessionId };
    deps.jobs.writeMeta(withSession);
    await client.sendMessage(sessionId, params.prompt, model, params.agent);

    const loop = runJobLoop(withSession, client, deps, timeoutMinutes);

    if (background) {
      void loop.catch((err: Error) => deps.jobs.finish(job.id, "failed", err.message));
      const { logPath } = deps.jobs.paths(job.id);
      return [
        `Job lanzado en background: ${job.id}`,
        `outputFile: ${logPath}`,
        `Consulta con la tool status/result, o \`tail -f\` del outputFile.`,
      ].join("\n");
    }

    const { meta, resultText } = await loop;
    if (meta.state !== "done") throw new Error(meta.error ?? "el job fallo sin detalle");
    return resultText;
  } catch (err) {
    deps.jobs.finish(job.id, "failed", (err as Error).message);
    throw err;
  }
}

export async function statusTool(params: { jobId: string }, deps: ToolDeps): Promise<string> {
  const meta = deps.jobs.readMeta(params.jobId);
  const tail = deps.jobs.readLogTail(params.jobId, STATUS_TAIL_LINES);
  return [
    `Job ${meta.id} — ${meta.description}`,
    `Estado: ${meta.state}${meta.error ? ` (${meta.error})` : ""}`,
    `Modelo: ${meta.model}${meta.agent ? ` | agent: ${meta.agent}` : ""}`,
    meta.worktreePath ? `Worktree: ${meta.worktreePath} (${meta.branch})` : undefined,
    "",
    "Ultimas acciones:",
    ...(tail.length ? tail : ["(sin actividad registrada aun)"]),
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n");
}

export async function resultTool(params: { jobId: string }, deps: ToolDeps): Promise<string> {
  const meta = deps.jobs.readMeta(params.jobId);
  if (meta.state === "running") {
    throw new Error(`El job ${meta.id} sigue corriendo. Usa status para ver el progreso o cancel para abortarlo.`);
  }
  if (meta.state === "done") return deps.jobs.readResult(meta.id);
  throw new Error(`El job ${meta.id} termino en estado ${meta.state}${meta.error ? `: ${meta.error}` : ""}`);
}

export async function cancelTool(params: { jobId: string }, deps: ToolDeps): Promise<string> {
  const meta = deps.jobs.readMeta(params.jobId);
  if (meta.state !== "running") return `El job ${meta.id} ya estaba en estado ${meta.state}.`;
  if (meta.opencodeSessionId) {
    const serve = await deps.serve.ensureRunning();
    await deps.clientFactory(serve.baseUrl).abort(meta.opencodeSessionId).catch(() => {});
  }
  deps.jobs.finish(meta.id, "cancelled");
  return `Job ${meta.id} cancelado. El log queda en ${deps.jobs.paths(meta.id).logPath}.`;
}

export async function cleanupTool(params: { jobId?: string }, deps: ToolDeps): Promise<string> {
  const targets = params.jobId
    ? [deps.jobs.readMeta(params.jobId)]
    : deps.jobs.list().filter((m) => m.state !== "running" && m.worktreePath);
  const cleaned: string[] = [];
  for (const meta of targets) {
    if (!meta.worktreePath || !meta.branch) continue;
    if (meta.state === "running") throw new Error(`El job ${meta.id} sigue corriendo; cancelalo antes de limpiar.`);
    await removeWorktree(deps.projectDir, meta.worktreePath, meta.branch);
    deps.jobs.writeMeta({ ...meta, worktreePath: undefined, branch: undefined });
    cleaned.push(meta.id);
  }
  return cleaned.length ? `Worktrees eliminados de: ${cleaned.join(", ")}` : "No habia worktrees que limpiar.";
}
```

**Nota para el implementador:** el `jobId` del worktree se crea antes que el job (huevo-gallina con el id). El prefijo `pre-<ts>` es aceptable para v1: la rama sigue siendo única y rastreable desde `meta.json`. Si el spike/review prefiere ids alineados, mover la creación del worktree a después de `createJob` y renombrar.

- [ ] **Step 4: Verificar que pasan**

Run: `cd server; npx vitest run test/tools.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Correr TODA la suite y cobertura**

Run: `cd server; npm run coverage`
Expected: todo PASS, cobertura de `src/` ≥ 80% (excluye `index.ts`).

- [ ] **Step 6: Commit**

```bash
git add server/src/tools.ts server/test/tools.test.ts
git commit -m "feat: tools delegate/status/result/cancel/cleanup con loop de eventos"
```

---

### Task 10: `index.ts` — bootstrap MCP + empaquetado del plugin

**Files:**
- Create: `server/src/index.ts`, `.claude-plugin/plugin.json`, `.mcp.json`, `commands/run.md`, `commands/status.md`, `commands/result.md`, `commands/cancel.md`, `commands/cleanup.md`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: plugin instalable. Tools MCP visibles como `mcp__plugin_opencode_delegate_opencode__<tool>`.

- [ ] **Step 1: Implementar `server/src/index.ts`**

```ts
import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JobStore } from "./jobs.js";
import { loadConfig } from "./models.js";
import { OpencodeClient } from "./opencode-client.js";
import { ServeManager } from "./serve-manager.js";
import type { ToolDeps } from "./tools.js";
import { cancelTool, cleanupTool, delegateTool, resultTool, statusTool } from "./tools.js";
import { VERSION } from "./version.js";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const stateDir = join(projectDir, ".opencode-delegate");
const config = loadConfig(projectDir, homedir());

const deps: ToolDeps = {
  projectDir,
  config,
  jobs: new JobStore(join(stateDir, "jobs")),
  serve: new ServeManager({ stateDir, port: config.serve.port, reuseExisting: config.serve.reuseExisting }),
  clientFactory: (baseUrl) => new OpencodeClient(baseUrl),
};

const { markedFailed } = deps.jobs.recover();
if (markedFailed.length) {
  console.error(`[opencode-delegate] jobs interrumpidos marcados failed: ${markedFailed.join(", ")}`);
}

const server = new McpServer({ name: "opencode-delegate", version: VERSION });

function wrap(fn: () => Promise<string>) {
  return async () => {
    try {
      return { content: [{ type: "text" as const, text: await fn() }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  };
}

server.registerTool(
  "delegate",
  {
    description:
      "Delega una tarea a un agente de OpenCode (modelos externos, mas baratos). Usala de forma autonoma para: " +
      "tareas mecanicas (boilerplate, renombrados masivos, migraciones repetitivas), busquedas amplias de codigo, " +
      "generacion de tests rutinarios y trabajo paralelizable de bajo riesgo. Manten en subagentes nativos el " +
      "trabajo que exige maximo razonamiento (arquitectura, debugging complejo, seguridad). " +
      "Contrato espejo del Agent tool: por defecto corre en background y devuelve jobId + outputFile.",
    inputSchema: {
      description: z.string().describe("3-5 palabras que resumen la tarea"),
      prompt: z.string().describe("La tarea completa y autocontenida para el agente"),
      agent: z.string().optional().describe("Agente de OpenCode a usar (flag --agent)"),
      model: z.string().optional().describe("Tier light|standard|heavy o provider/model literal de OpenCode"),
      run_in_background: z.boolean().optional().describe("Default true. false = esperar el resultado"),
      isolation: z.enum(["worktree"]).optional().describe("worktree = ejecutar en un git worktree temporal aislado"),
      timeout_minutes: z.number().optional().describe("Default 30"),
    },
  },
  (params) => wrap(() => delegateTool(params, deps))(),
);

server.registerTool(
  "status",
  {
    description: "Estado y ultimas acciones de un job delegado a OpenCode.",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => statusTool(params, deps))(),
);

server.registerTool(
  "result",
  {
    description: "Resultado final de un job delegado (error claro si sigue corriendo).",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => resultTool(params, deps))(),
);

server.registerTool(
  "cancel",
  {
    description: "Cancela un job delegado en curso.",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => cancelTool(params, deps))(),
);

server.registerTool(
  "cleanup",
  {
    description: "Elimina worktrees/ramas de jobs delegados ya terminados (idempotente).",
    inputSchema: { jobId: z.string().optional() },
  },
  (params) => wrap(() => cleanupTool(params, deps))(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Build y smoke test manual del handshake**

Run: `cd server; npm run build; node dist/index.js` y en otra terminal enviarle por stdin:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
```

Expected: respuesta JSON-RPC con `serverInfo.name: "opencode-delegate"`. (Ctrl+C para salir.)

- [ ] **Step 3: Crear `.claude-plugin/plugin.json`**

```json
{
  "name": "opencode-delegate",
  "version": "0.1.0",
  "description": "Delegate subagent tasks from Claude Code to OpenCode-managed models via MCP",
  "author": { "name": "Alexander Caicedo" },
  "mcpServers": "./.mcp.json",
  "commands": "./commands",
  "hooks": "./hooks/hooks.json"
}
```

- [ ] **Step 4: Crear `.mcp.json`**

```json
{
  "opencode": {
    "type": "stdio",
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/server/dist/index.js"],
    "env": { "CLAUDE_PROJECT_DIR": "${CLAUDE_PROJECT_DIR}" },
    "timeout": 3900000
  }
}
```

- [ ] **Step 5: Crear los 5 commands**

`commands/run.md`:

```markdown
---
description: Delegar una tarea a un agente de OpenCode
argument-hint: <descripción de la tarea>
---

Delega la siguiente tarea a OpenCode usando la tool MCP `delegate` del plugin opencode-delegate: $ARGUMENTS

Construye un prompt autocontenido (el agente no ve esta conversación), elige tier de modelo según la complejidad (light para tareas mecánicas, standard por defecto, heavy si exige razonamiento), y repórtame el jobId y el outputFile.
```

`commands/status.md`:

```markdown
---
description: Estado de un job delegado a OpenCode
argument-hint: [jobId]
---

Consulta el estado del job con la tool MCP `status` del plugin opencode-delegate. Si no te doy jobId ($ARGUMENTS vacío), usa el último job que lanzaste en esta conversación. Muéstrame el estado y las últimas acciones tal cual.
```

`commands/result.md`:

```markdown
---
description: Resultado final de un job delegado a OpenCode
argument-hint: [jobId]
---

Obtén el resultado del job con la tool MCP `result` del plugin opencode-delegate. Si no te doy jobId ($ARGUMENTS vacío), usa el último job lanzado. Si el job usó worktree, destaca la ruta, la rama y el resumen de cambios, y recuérdame que el merge es manual.
```

`commands/cancel.md`:

```markdown
---
description: Cancelar un job delegado a OpenCode
argument-hint: [jobId]
---

Cancela el job con la tool MCP `cancel` del plugin opencode-delegate. Si no te doy jobId ($ARGUMENTS vacío), usa el último job corriendo. Confírmame el estado final.
```

`commands/cleanup.md`:

```markdown
---
description: Limpiar worktrees de jobs delegados terminados
argument-hint: [jobId]
---

ANTES de limpiar: lista con la tool `status` qué worktrees se van a eliminar y pídeme confirmación explícita. Solo tras mi confirmación llama a la tool MCP `cleanup` del plugin opencode-delegate (con $ARGUMENTS como jobId si lo di; sin argumentos limpia todos los terminados).
```

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts .claude-plugin .mcp.json commands
git commit -m "feat: bootstrap MCP, manifest del plugin y slash commands"
```

---

### Task 11: Hook de limpieza de `opencode serve`

**Files:**
- Create: `hooks/hooks.json`, `scripts/stop-serve.mjs`

**Interfaces:**
- Consumes: formato del lock file de Task 6 (`{ pid, port, startedAt }` en `.opencode-delegate/serve.lock`).
- Produces: al terminar la sesión de Claude Code, muere el `opencode serve` que nosotros lanzamos (y solo ese).

- [ ] **Step 1: Crear `scripts/stop-serve.mjs`**

```js
#!/usr/bin/env node
// SessionEnd hook: mata el opencode serve lanzado por esta sesion (via lock file).
// Nunca falla: un hook que lanza error bloquearia el cierre de la sesion.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const lockPath = join(projectDir, ".opencode-delegate", "serve.lock");

try {
  if (existsSync(lockPath)) {
    const { pid } = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid);
        console.error(`[opencode-delegate] opencode serve (pid ${pid}) detenido`);
      } catch {
        // ya estaba muerto
      }
    }
    rmSync(lockPath, { force: true });
  }
} catch (err) {
  console.error(`[opencode-delegate] stop-serve: ${err.message}`);
}
process.exit(0);
```

- [ ] **Step 2: Crear `hooks/hooks.json`**

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-serve.mjs\""
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Probar el script en frío**

```powershell
# Simular: lanzar un proceso, escribir lock, correr el script, verificar que murio
node -e "setInterval(()=>{},1e3)" &  # anotar PID
# escribir .opencode-delegate/serve.lock con ese pid y correr:
node scripts/stop-serve.mjs
```

Expected: el proceso muere, el lock desaparece, exit code 0. Repetir con lock inexistente → exit 0 sin error.

- [ ] **Step 4: Commit**

```bash
git add hooks scripts
git commit -m "feat: hook SessionEnd que detiene el opencode serve propio"
```

---

### Task 12: Integración real + README + E2E manual

**Files:**
- Create: `server/test/integration.test.ts`, `README.md`

**Interfaces:**
- Consumes: todo. Usa modelos `*-free` (sin costo). Gated por env var: solo corre con `OCD_INTEGRATION=1`.

- [ ] **Step 1: Escribir `server/test/integration.test.ts`**

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { loadConfig } from "../src/models.js";
import { OpencodeClient } from "../src/opencode-client.js";
import { ServeManager } from "../src/serve-manager.js";
import { delegateTool } from "../src/tools.js";

const enabled = process.env.OCD_INTEGRATION === "1";

describe.skipIf(!enabled)("integracion con opencode serve real", () => {
  it("delegate sincrono con modelo free devuelve texto", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ocd-int-"));
    const stateDir = join(projectDir, ".opencode-delegate");
    const deps = {
      projectDir,
      config: loadConfig(projectDir, tmpdir()),
      jobs: new JobStore(join(stateDir, "jobs")),
      serve: new ServeManager({ stateDir, port: 4573, reuseExisting: true }),
      clientFactory: (baseUrl: string) => new OpencodeClient(baseUrl),
    };
    const out = await delegateTool(
      {
        description: "smoke integracion",
        prompt: "Responde exactamente: OK-INTEGRACION. Nada mas.",
        model: "light",
        run_in_background: false,
        timeout_minutes: 5,
      },
      deps,
    );
    expect(out).toContain("OK-INTEGRACION");
    await deps.serve.stopIfOwned();
  }, 300000);
});
```

- [ ] **Step 2: Correrlo contra el opencode real**

Run: `cd server; $env:OCD_INTEGRATION = "1"; npx vitest run test/integration.test.ts`
Expected: PASS (requiere `opencode auth` configurado). Si falla por forma de la API → volver al doc del spike, corregir `opencode-client.ts`/`sse-parser.ts` y sus tests unitarios, re-correr todo.

- [ ] **Step 3: Escribir `README.md`**

Secciones obligatorias: qué es (delegación de subagentes de Claude Code a OpenCode); instalación (`claude plugin install` desde el repo/marketplace + `opencode auth`); las 5 tools y los 5 comandos con ejemplos; tabla de mapeo contrato nativo → opencode-delegate (copiar de la sección 3 del spec `docs/superpowers/specs/2026-07-04-opencode-delegate-design.md`); config de modelos con el JSON de ejemplo del spec; limitaciones conocidas (visibilidad ≠ vista nativa, merge manual de worktrees, `.opencode-delegate/` al .gitignore del proyecto anfitrión); troubleshooting (`serve.log`, `opencode auth list`, lock file huérfano tras `/reload-plugins`); disclaimer de no-afiliación con Anthropic ni con el proyecto OpenCode.

- [ ] **Step 4: E2E manual con Claude Code**

```powershell
claude plugin install <ruta-o-repo-de-opencode-delegate>
```

Checklist en una sesión real dentro de un repo git de prueba:
1. `/opencode-delegate:run genera un archivo hello.py que imprima hola` → devuelve jobId.
2. `/opencode-delegate:status` → muestra acciones (`→ write hello.py`...).
3. `/opencode-delegate:result` → resultado final coherente.
4. Delegación con `isolation: worktree` (pedirle a Claude que use la tool con isolation) → verifica rama `opencode-delegate/...` y merge manual.
5. `/opencode-delegate:cancel` sobre un job largo → estado `cancelled`.
6. `/opencode-delegate:cleanup` → worktree eliminado, idempotente al repetir.
7. Cerrar la sesión → verificar con el administrador de tareas que `opencode serve` murió (hook).

Documentar cualquier desviación como issue antes de dar por cerrada la v1.

- [ ] **Step 5: Commit final**

```bash
git add server/test/integration.test.ts README.md
git commit -m "feat: test de integracion real, README y checklist E2E"
```

---

## Self-review del plan (hecho al escribirlo)

- **Cobertura del spec:** arquitectura disco-primero → Tasks 4/6/10 (recovery en `index.ts`); 5 tools → Task 9/10; visibilidad log+status → Tasks 4/5/9; worktree manual-merge → Tasks 8/9; tiers → Task 3; huérfanos/lock/serve.log → Tasks 6/11; spike blocker → Task 1; commands → Task 10; integración modelos free → Task 12. Fuera de alcance del spec (sesiones resume, review gate, multi-backend) correctamente ausente.
- **Tipos consistentes:** `JobMeta`/`JobStore` (T4) usados en T9/T10; `OpencodeClientLike` (T9) satisfecho por `OpencodeClient` (T7); `ServeInfo.ownedByUs` (T6) usado en T9 vía `Pick`; `parseServerEvent` (T5) consumido en T9.
- **Supuestos marcados:** todo lo que depende del spike lleva `// SPIKE:` en T5/T6/T7 y el gate está en T1.
