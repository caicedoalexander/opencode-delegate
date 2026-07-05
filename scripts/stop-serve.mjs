#!/usr/bin/env node
// SessionEnd hook: mata el opencode serve lanzado por esta sesion (via lock file).
// Nunca falla: un hook que lanza error bloquearia el cierre de la sesion.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const lockPath = join(projectDir, ".opencode-delegate", "serve.lock");

try {
  if (existsSync(lockPath)) {
    const { pid } = JSON.parse(readFileSync(lockPath, "utf8"));
    if (typeof pid === "number" && pid > 0) {
      try {
        process.kill(pid);
        console.error(`[opencode-delegate] opencode serve (pid ${pid}) detenido`);
      } catch {
        // ya estaba muerto
      }
    }
    rmSync(lockPath, { force: true });
  }
} catch (err) {
  console.error(`[opencode-delegate] stop-serve: ${err.message}`);
}
process.exit(0);
