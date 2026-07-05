import type { JobMeta, JobStore } from "./jobs.js";
import type { DelegateConfig } from "./models.js";
import { resolveModel } from "./models.js";
import { parseServerEvent } from "./sse-parser.js";
import type { ServeManager } from "./serve-manager.js";
import { createWorktree, diffStat, removeWorktree } from "./worktree.js";

/**
 * Cliente inyectable para tools.ts (Task 9).
 *
 * ADAPTACION vs. el diseno original: `sendMessage` es BLOQUEANTE (spike +
 * Task 7, `opencode-client.ts`) — resuelve con el texto final cuando el turno
 * termina (exito, error de modelo via info.error, o abort), y rechaza en
 * errores HTTP/red. Ya NO hace falta esperar `session.idle` por el stream de
 * eventos: la resolucion/rechazo de `sendMessage` es la senal de completitud.
 * El stream de `subscribe` sigue usandose solo para visibilidad (lineas de
 * tool call en el log).
 */
export interface OpencodeClientLike {
  createSession(directory?: string): Promise<string>;
  sendMessage(sessionId: string, text: string, model: string, agent?: string): Promise<{ text: string }>;
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

// Formato real de id generado por JobStore.createJob (jobs.ts):
// `ocd-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`.
const JOB_ID_PATTERN = /^ocd-[0-9a-z]+-[0-9a-f]{4}$/;

/**
 * Valida el jobId en el borde de la tool ANTES de cualquier acceso a
 * filesystem: `jobId` llega directo del caller MCP y JobStore lo usa en
 * `join(baseDir, id)` sin sanitizar, asi que un valor como "../../otro" podria
 * escapar del directorio de jobs.
 */
function assertValidJobId(id: string): void {
  if (!JOB_ID_PATTERN.test(id)) throw new Error(`jobId invalido: ${id}`);
}

interface JobOutcome {
  meta: JobMeta;
  resultText: string;
}

/**
 * Corre un job hasta que `sendMessage` (el turno bloqueante) se resuelve o
 * rechaza. En paralelo arranca `subscribe` solo para volcar lineas de tool
 * call al log (con supresion de duplicados consecutivos, ya que el stream
 * real emite 2+ eventos "running" identicos por cada tool call).
 */
async function runJob(job: JobMeta, client: OpencodeClientLike, deps: ToolDeps, timeoutMinutes: number): Promise<JobOutcome> {
  const sessionId = job.opencodeSessionId!;
  const subCtrl = new AbortController();
  let lastToolLine: string | undefined;

  const subscribeDone = client
    .subscribe((evt) => {
      const parsed = parseServerEvent(evt);
      if (parsed.sessionId !== sessionId) return;
      if (parsed.kind !== "tool" || !parsed.line) return;
      if (parsed.line === lastToolLine) return; // supresion de duplicados consecutivos
      lastToolLine = parsed.line;
      deps.jobs.appendLog(job.id, parsed.line);
    }, subCtrl.signal)
    .catch((err: Error) => {
      // Excepcion sancionada: el stream de eventos es solo para visibilidad;
      // si falla (red), se registra pero NO tumba el job — el POST bloqueante
      // de sendMessage es la fuente de verdad sobre el resultado del turno.
      deps.jobs.appendLog(job.id, `(aviso: stream de eventos interrumpido: ${err.message})`);
    });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void client.abort(sessionId).catch(() => {});
  }, timeoutMinutes * 60_000);

  let finalText = "";
  let failure: string | undefined;
  try {
    const result = await client.sendMessage(sessionId, job.prompt, job.model, job.agent);
    finalText = result.text.trim() || "(el agente termino sin texto de respuesta)";
  } catch (err) {
    // El timeout gana sobre el mensaje de error inducido por el abort
    // (p. ej. MessageAbortedError), que es ruido esperado en ese caso.
    failure = timedOut ? `Timeout tras ${timeoutMinutes} minutos` : (err as Error).message;
  } finally {
    clearTimeout(timer);
    subCtrl.abort();
    await subscribeDone;
  }

  // No pisar un estado terminal escrito por cancelTool mientras corriamos.
  const current = deps.jobs.readMeta(job.id);
  if (current.state !== "running") return { meta: current, resultText: finalText };

  if (failure === undefined) {
    let text = finalText;
    if (current.worktreePath && current.branch) {
      const stat = await diffStat(current.worktreePath).catch((e: Error) => `(diffstat fallo: ${e.message})`);
      text += `\n\n---\nWorktree: ${current.worktreePath}\nRama: ${current.branch}\nCambios:\n${stat || "(sin cambios)"}`;
    }
    deps.jobs.writeResult(job.id, text);
    const meta = deps.jobs.finish(job.id, "done");
    return { meta, resultText: text };
  }
  const meta = deps.jobs.finish(job.id, "failed", failure);
  return { meta, resultText: finalText };
}

export async function delegateTool(params: DelegateParams, deps: ToolDeps): Promise<string> {
  const model = resolveModel(params.model, deps.config);
  const background = params.run_in_background !== false;
  const timeoutMinutes = params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES;

  const job = deps.jobs.createJob({
    description: params.description,
    prompt: params.prompt,
    agent: params.agent,
    model,
    isolation: params.isolation,
  });
  deps.jobs.appendLog(job.id, `[${job.createdAt}] job ${job.id} (${model}) — ${params.description}`);

  try {
    let worktree: { path: string; branch: string } | undefined;
    if (params.isolation === "worktree") {
      worktree = await createWorktree(deps.projectDir, job.id);
      // Disco-primero: el worktree ya existe en disco antes de que meta.json
      // lo referencie, para que un crash a mitad de escritura nunca deje un
      // meta.json apuntando a un worktree inexistente.
      const withWorktree: JobMeta = { ...deps.jobs.readMeta(job.id), worktreePath: worktree.path, branch: worktree.branch };
      deps.jobs.writeMeta(withWorktree);
    }

    const serve = await deps.serve.ensureRunning();
    const client = deps.clientFactory(serve.baseUrl);
    const sessionId = await client.createSession(worktree?.path ?? deps.projectDir);
    const withSession: JobMeta = { ...deps.jobs.readMeta(job.id), opencodeSessionId: sessionId };
    deps.jobs.writeMeta(withSession);

    // OJO: no se hace `await` de `runJob` aqui en modo background — la
    // llamada a `client.sendMessage(...)` dentro de `runJob` ES el turno; el
    // job queda corriendo en background mientras el POST bloqueante sigue en vuelo.
    const loop = runJob(withSession, client, deps, timeoutMinutes);

    if (background) {
      void loop.catch((err: Error) => {
        try {
          deps.jobs.finish(job.id, "failed", err.message);
        } catch {
          // el job pudo haber sido limpiado/cancelado concurrentemente: no hay nada mas que hacer.
        }
      });
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
    // No pisar un estado terminal (done/failed/cancelled) ya escrito por
    // runJob o por un cancelTool concurrente: solo marcamos failed si el job
    // seguia "running" cuando llegamos aqui (p. ej. fallo antes de runJob,
    // como ensureRunning/createSession).
    const current = deps.jobs.readMeta(job.id);
    if (current.state === "running") {
      deps.jobs.finish(job.id, "failed", (err as Error).message);
      throw err;
    }
    if (current.state === "cancelled") {
      throw new Error(`El job ${job.id} fue cancelado`);
    }
    throw err;
  }
}

export async function statusTool(params: { jobId: string }, deps: ToolDeps): Promise<string> {
  assertValidJobId(params.jobId);
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
  assertValidJobId(params.jobId);
  const meta = deps.jobs.readMeta(params.jobId);
  if (meta.state === "running") {
    throw new Error(`El job ${meta.id} sigue corriendo. Usa status para ver el progreso o cancel para abortarlo.`);
  }
  if (meta.state === "done") return deps.jobs.readResult(meta.id);
  throw new Error(`El job ${meta.id} termino en estado ${meta.state}${meta.error ? `: ${meta.error}` : ""}`);
}

export async function cancelTool(params: { jobId: string }, deps: ToolDeps): Promise<string> {
  assertValidJobId(params.jobId);
  const meta = deps.jobs.readMeta(params.jobId);
  if (meta.state !== "running") return `El job ${meta.id} ya estaba en estado ${meta.state}.`;
  if (meta.opencodeSessionId) {
    const serve = await deps.serve.ensureRunning();
    await deps
      .clientFactory(serve.baseUrl)
      .abort(meta.opencodeSessionId)
      .catch(() => {});
  }
  deps.jobs.finish(meta.id, "cancelled");
  return `Job ${meta.id} cancelado. El log queda en ${deps.jobs.paths(meta.id).logPath}.`;
}

export async function cleanupTool(params: { jobId?: string }, deps: ToolDeps): Promise<string> {
  if (params.jobId !== undefined) assertValidJobId(params.jobId);
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
