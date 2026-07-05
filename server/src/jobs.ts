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
  /** PID del proceso MCP server que creo el job (Task recover multi-sesion). */
  ownerPid?: number;
}

/**
 * Chequea si un proceso sigue vivo sin matarlo (`process.kill(pid, 0)`).
 * ESRCH -> el proceso no existe (muerto). EPERM -> existe pero sin permiso
 * para señalizarlo (vivo). Sin excepcion -> vivo.
 * Riesgo aceptado: un PID reciclado por otro proceso hace parecer vivo a un
 * dueño muerto (el job queda "running" hasta un `cancel` manual) — misma
 * clase de riesgo asumida en el lock de serve, ventana corta en la práctica.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class JobStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  paths(id: string) {
    const dir = join(this.baseDir, id);
    return { dir, metaPath: join(dir, "meta.json"), logPath: join(dir, "output.log"), resultPath: join(dir, "result.md") };
  }

  createJob(init: Omit<JobMeta, "id" | "state" | "createdAt" | "ownerPid">): JobMeta {
    const id = `ocd-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const meta: JobMeta = { ...init, id, state: "running", createdAt: new Date().toISOString(), ownerPid: process.pid };
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

  /**
   * Post-arranque: un job "running" solo se marca failed si su proceso dueno
   * (ownerPid) ya no esta vivo. Si ownerPid esta ausente (meta legacy) se
   * asume dueno muerto (comportamiento previo). Si el dueno sigue vivo (otra
   * sesion concurrente de Claude Code compartiendo `.opencode-delegate/`), el
   * job se deja completamente intacto: sin ownerPid, no hay forma de saber si
   * el job pertenece a este proceso o a uno vivo distinto.
   */
  recover(): { markedFailed: string[] } {
    const markedFailed: string[] = [];
    for (const meta of this.list()) {
      if (meta.state !== "running") continue;
      if (meta.ownerPid !== undefined && isProcessAlive(meta.ownerPid)) continue;
      this.finish(meta.id, "failed", "Interrumpido: el MCP server se reinicio con el job en curso");
      markedFailed.push(meta.id);
    }
    return { markedFailed };
  }
}
