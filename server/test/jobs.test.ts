import { spawnSync } from "node:child_process";
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

  it("createJob estampa ownerPid con el pid del proceso actual", () => {
    const store = makeStore();
    const job = store.createJob(INIT);
    expect(job.ownerPid).toBe(process.pid);
  });

  it("recover no toca un job running cuyo ownerPid sigue vivo (sesion concurrente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-jobs-"));
    const store1 = new JobStore(dir);
    const running = store1.createJob(INIT); // ownerPid = process.pid (este proceso de test, vivo)
    const done = store1.createJob(INIT);
    store1.finish(done.id, "done");

    const store2 = new JobStore(dir);
    const { markedFailed } = store2.recover();
    expect(markedFailed).toEqual([]);
    expect(store2.readMeta(running.id)).toEqual(running);
    expect(store2.readMeta(done.id).state).toBe("done");
  });

  it("recover marca failed un job running cuyo ownerPid ya murio", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-jobs-"));
    const store1 = new JobStore(dir);
    const running = store1.createJob(INIT);

    // PID confiablemente muerto: proceso hijo de corta vida ya finalizado.
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid!;
    store1.writeMeta({ ...store1.readMeta(running.id), ownerPid: deadPid });

    const store2 = new JobStore(dir);
    const { markedFailed } = store2.recover();
    expect(markedFailed).toEqual([running.id]);
    expect(store2.readMeta(running.id).state).toBe("failed");
  });

  it("recover marca failed un job running con meta legacy sin ownerPid (compat hacia atras)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocd-jobs-"));
    const store1 = new JobStore(dir);
    const running = store1.createJob(INIT);
    const { ownerPid: _ownerPid, ...legacyMeta } = store1.readMeta(running.id);
    store1.writeMeta(legacyMeta as typeof running);

    const store2 = new JobStore(dir);
    const { markedFailed } = store2.recover();
    expect(markedFailed).toEqual([running.id]);
    expect(store2.readMeta(running.id).state).toBe("failed");
  });

  it("readMeta de job inexistente lanza error claro", () => {
    expect(() => makeStore().readMeta("ocd-nope")).toThrow(/no existe/i);
  });
});
