import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { DEFAULT_CONFIG } from "../src/models.js";
import type { OpencodeClientLike, ToolDeps } from "../src/tools.js";
import { cancelTool, cleanupTool, delegateTool, resultTool, statusTool } from "../src/tools.js";

/**
 * FakeClient: sendMessage es BLOQUEANTE en la interfaz real (Task 7,
 * `opencode-client.ts`) — resuelve/rechaza cuando el turno termina. Aqui se
 * modela con promesas controlables por el test via resolveSend/rejectSend,
 * en vez de emitir eventos "text"/"session.idle" por el stream (eso ya no
 * decide la completitud del job).
 */
class FakeClient implements OpencodeClientLike {
  aborted: string[] = [];
  private listeners: Array<(evt: unknown) => void> = [];
  private pendingResolve: Array<(r: { text: string }) => void> = [];
  private pendingReject: Array<(e: Error) => void> = [];

  async createSession(): Promise<string> {
    return "ses_fake";
  }

  async sendMessage(): Promise<{ text: string }> {
    return new Promise((resolve, reject) => {
      this.pendingResolve.push(resolve);
      this.pendingReject.push(reject);
    });
  }

  resolveSend(text: string): void {
    const resolve = this.pendingResolve.pop();
    this.pendingReject.pop();
    resolve?.({ text });
  }

  rejectSend(err: Error): void {
    const reject = this.pendingReject.pop();
    this.pendingResolve.pop();
    reject?.(err);
  }

  async abort(sessionId: string): Promise<void> {
    this.aborted.push(sessionId);
    // Modela el comportamiento real: abortar hace que el POST bloqueante
    // en vuelo se resuelva/rechace (spike: 200 con info.error -> Task 7 lo
    // convierte en throw).
    this.rejectSend(new Error("MessageAbortedError"));
  }

  async subscribe(onEvent: (evt: unknown) => void, signal: AbortSignal): Promise<void> {
    this.listeners.push(onEvent);
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  }

  emit(evt: unknown): void {
    for (const l of this.listeners) l(evt);
  }
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

function toolEvt(sessionId = "ses_fake", filePath = "a.ts") {
  return {
    type: "message.part.updated",
    properties: {
      sessionID: sessionId,
      part: { type: "tool", tool: "read", state: { status: "running", input: { filePath } } },
    },
  };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

function extractJobId(out: string): string {
  return /ocd-[a-z0-9-]+/.exec(out)![0];
}

describe("delegateTool background (default)", () => {
  it("devuelve jobId + outputFile de inmediato y el job termina done cuando sendMessage resuelve", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    expect(out).toContain("output.log");
    await tick();
    client.resolveSend("resultado parcial");
    await tick();
    const meta = deps.jobs.readMeta(jobId);
    expect(meta.state).toBe("done");
    expect(deps.jobs.readResult(jobId)).toContain("resultado parcial");
  });

  it("ignora lineas de tool de otras sesiones en el log", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    client.emit(toolEvt("ses_OTRA"));
    await tick();
    expect(deps.jobs.readLogTail(jobId, 10).some((l) => l.includes("→ read"))).toBe(false);
    client.emit(toolEvt());
    await tick();
    expect(deps.jobs.readLogTail(jobId, 10).some((l) => l.includes("→ read a.ts"))).toBe(true);
    client.resolveSend("listo");
    await tick();
  });

  it("suprime lineas de tool duplicadas consecutivas (el stream real emite 2+ 'running' identicos)", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    client.emit(toolEvt());
    client.emit(toolEvt());
    client.emit(toolEvt());
    await tick();
    const toolLines = deps.jobs.readLogTail(jobId, 20).filter((l) => l.includes("→ read a.ts"));
    expect(toolLines.length).toBe(1);
    client.resolveSend("listo");
    await tick();
  });

  it("sendMessage rechazada marca el job failed con el mensaje", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    client.rejectSend(new Error("sin creditos"));
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
    client.resolveSend("todo listo");
    const out = await pending;
    expect(out).toContain("todo listo");
  });

  it("timeout marca failed con 'Timeout tras...' (aunque el abort induzca su propio error) y aborta la sesion", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool({ ...PARAMS, run_in_background: false, timeout_minutes: 0.001 }, deps).catch(
      (e: Error) => e.message,
    );
    expect(out).toMatch(/[Tt]imeout/);
    expect(client.aborted).toContain("ses_fake");
  });
});

describe("statusTool / resultTool / cancelTool / cleanupTool", () => {
  it("status muestra estado y ultimas acciones del log", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    client.emit(toolEvt());
    await tick();
    const status = await statusTool({ jobId }, deps);
    expect(status).toContain("running");
    expect(status).toContain("→ read a.ts");
    client.resolveSend("listo");
    await tick();
  });

  it("result falla claro si el job sigue corriendo", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await expect(resultTool({ jobId }, deps)).rejects.toThrow(/sigue corriendo|running/i);
    client.resolveSend("listo");
    await tick();
  });

  it("cancel aborta la sesion y marca cancelled", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    const msg = await cancelTool({ jobId }, deps);
    expect(msg).toContain(jobId);
    expect(client.aborted).toContain("ses_fake");
    expect(deps.jobs.readMeta(jobId).state).toBe("cancelled");
  });

  it("cancel-then-settle: el rechazo tardio de sendMessage (por el abort) no pisa el estado 'cancelled'", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    await cancelTool({ jobId }, deps);
    expect(deps.jobs.readMeta(jobId).state).toBe("cancelled");
    // El abort() de FakeClient ya disparo el rechazo del sendMessage en vuelo;
    // dejamos que runJob termine de procesarlo y confirmamos que no reescribe el estado.
    await tick();
    const meta = deps.jobs.readMeta(jobId);
    expect(meta.state).toBe("cancelled");
    expect(meta.error).toBeUndefined();
  });

  it("cleanup sin jobId no falla cuando no hay worktrees que limpiar", async () => {
    const client = new FakeClient();
    const deps = makeDeps(client);
    const out = await delegateTool(PARAMS, deps);
    const jobId = extractJobId(out);
    await tick();
    client.resolveSend("listo");
    await tick();
    const msg = await cleanupTool({}, deps);
    expect(msg).toMatch(/No habia worktrees/);
    void jobId;
  });
});
