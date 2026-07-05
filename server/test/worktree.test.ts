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
