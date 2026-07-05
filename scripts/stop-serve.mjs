#!/usr/bin/env node
// SessionEnd hook: mata el opencode serve lanzado por esta sesion (via lock file).
// Nunca falla: un hook que lanza error bloquearia el cierre de la sesion.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const lockPath = join(projectDir, ".opencode-delegate", "serve.lock");

if (existsSync(lockPath)) {
  try {
    const { pid } = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid);
        console.error(`[opencode-delegate] opencode serve (pid ${pid}) detenido`);
      } catch {
        // ya estaba muerto
      }
    }
  } catch (err) {
    console.error(`[opencode-delegate] stop-serve: ${err.message}`);
  } finally {
    // Always remove the lock file, even if it was corrupted.
    // Note: PID reuse is possible if recycled by the OS; accepted risk since lock is short-lived.
    rmSync(lockPath, { force: true });
  }
}

process.exit(0);
