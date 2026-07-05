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
