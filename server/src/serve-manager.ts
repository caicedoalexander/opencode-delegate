import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  /** true si esta instancia fue la que spawneo el proceso (independiente de si sigue vivo). */
  private ownsSpawn = false;

  constructor(private readonly opts: ServeManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.lockPath = join(opts.stateDir, "serve.lock");
    this.logPath = join(opts.stateDir, "serve.log");
  }

  private baseUrl(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  // Health check endpoint: GET /global/health (per spike Task 1 findings)
  private async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/global/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning(): Promise<ServeInfo> {
    if (this.opts.reuseExisting && (await this.isHealthy())) {
      const lock = this.readLock();
      return { baseUrl: this.baseUrl(), pid: lock?.pid ?? -1, ownedByUs: this.ownsSpawn };
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
    // `spawn` duplica el fd para el hijo (tanto en POSIX como en Windows) antes de retornar,
    // asi que podemos cerrar nuestra copia inmediatamente sin afectar el logging del proceso hijo.
    const child = spawn(bin, args, { stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    this.child = child;
    this.ownsSpawn = true;
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
    if (!this.ownsSpawn) return;
    if (this.child && this.child.exitCode === null) {
      this.child.kill();
    }
    this.child = undefined;
    rmSync(this.lockPath, { force: true });
  }
}
