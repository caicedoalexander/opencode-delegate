#!/usr/bin/env node
// Instalador de opencode-delegate: verifica prerequisitos, compila el server
// MCP y registra el plugin en Claude Code. Multiplataforma (Windows/macOS/
// Linux); requiere el mismo Node 20+ que ya exige el plugin.
// Uso: node scripts/install.mjs   (desde la raiz del repo)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_MAJOR = 20;
const MARKETPLACE = "opencode-delegate";
const PLUGIN = "opencode-delegate";

function step(msg) {
  console.log(`\n==> ${msg}`);
}

function fail(msg) {
  console.error(`\nERROR: ${msg}`);
  process.exit(1);
}

// shell:true para resolver shims .cmd/.ps1 en Windows (npm, claude, opencode).
// Comando como string unico: los args son constantes del script (o rutas ya
// entrecomilladas), y evita el DEP0190 de args + shell.
function run(cmd, args, opts = {}) {
  const pretty = [cmd, ...args].join(" ");
  const res = spawnSync(pretty, {
    cwd: opts.cwd ?? repoRoot,
    shell: true,
    encoding: "utf8",
    stdio: opts.capture ? "pipe" : "inherit",
  });
  return { ...res, pretty };
}

function commandExists(cmd) {
  return run(cmd, ["--version"], { capture: true }).status === 0;
}

// --- 1. Prerequisitos -------------------------------------------------------
step("Verificando prerequisitos");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < MIN_NODE_MAJOR) {
  fail(`Se requiere Node ${MIN_NODE_MAJOR}+ (tienes ${process.versions.node}).`);
}
console.log(`  node ${process.versions.node} OK`);

if (!commandExists("claude")) {
  fail("CLI `claude` no encontrada. Instala Claude Code primero: https://claude.com/claude-code");
}
console.log("  claude CLI OK");

if (!commandExists("opencode")) {
  fail("CLI `opencode` no encontrada. Instalala primero: https://opencode.ai");
}
console.log("  opencode CLI OK");

const auth = run("opencode", ["auth", "list"], { capture: true });
const hasAuth = auth.status === 0 && /\S/.test(auth.stdout ?? "");
if (hasAuth) {
  console.log("  opencode auth OK");
} else {
  console.warn(
    "  AVISO: `opencode auth list` no muestra credenciales. El plugin se " +
      "instalara igual, pero los modelos no responderan hasta hacer `opencode auth login`.",
  );
}

// --- 2. Compilar el server MCP ---------------------------------------------
step("Compilando el server MCP (server/)");

const serverDir = join(repoRoot, "server");
if (!existsSync(join(serverDir, "package.json"))) {
  fail(`No se encontro server/package.json. Ejecuta el script desde el repo clonado (raiz detectada: ${repoRoot}).`);
}
for (const args of [["install"], ["run", "build"]]) {
  const res = run("npm", args, { cwd: serverDir });
  if (res.status !== 0) fail(`\`${res.pretty}\` fallo (exit ${res.status}). Revisa la salida de arriba.`);
}

// --- 3. Registrar marketplace e instalar el plugin --------------------------
step("Registrando el repo como marketplace local");

const add = run("claude", ["plugin", "marketplace", "add", `"${repoRoot}"`], { capture: true });
if (add.status === 0) {
  console.log(`  marketplace ${MARKETPLACE} registrado`);
} else if (/already|ya existe/i.test(`${add.stdout}${add.stderr}`)) {
  console.log(`  marketplace ${MARKETPLACE} ya estaba registrado`);
} else {
  fail(`\`${add.pretty}\` fallo:\n${add.stdout}${add.stderr}`);
}

step("Instalando el plugin en Claude Code");

const install = run("claude", ["plugin", "install", `${PLUGIN}@${MARKETPLACE}`], { capture: true });
if (install.status === 0) {
  console.log(`  plugin ${PLUGIN} instalado`);
} else if (/already|ya esta instalado/i.test(`${install.stdout}${install.stderr}`)) {
  console.log(`  plugin ${PLUGIN} ya estaba instalado`);
} else {
  fail(`\`${install.pretty}\` fallo:\n${install.stdout}${install.stderr}`);
}

// --- 4. Listo ----------------------------------------------------------------
step("Instalacion completa");
console.log(`
Siguientes pasos:
  - Anade \`.opencode-delegate/\` al .gitignore de cada proyecto donde uses el plugin.${hasAuth ? "" : "\n  - Autentica OpenCode: `opencode auth login` (verifica con `opencode auth list`)."}
  - Abre una sesion de Claude Code y prueba: /opencode-delegate:run genera un hello.py
`);
