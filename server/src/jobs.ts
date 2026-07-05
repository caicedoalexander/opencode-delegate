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
