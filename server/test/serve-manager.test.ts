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
