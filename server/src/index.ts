import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { JobStore } from "./jobs.js";
import { loadConfig } from "./models.js";
import { OpencodeClient } from "./opencode-client.js";
import { ServeManager } from "./serve-manager.js";
import type { ToolDeps } from "./tools.js";
import { cancelTool, cleanupTool, delegateTool, resultTool, statusTool } from "./tools.js";
import { VERSION } from "./version.js";
import { join } from "node:path";

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const stateDir = join(projectDir, ".opencode-delegate");
const config = loadConfig(projectDir, homedir());

const deps: ToolDeps = {
  projectDir,
  config,
  jobs: new JobStore(join(stateDir, "jobs")),
  serve: new ServeManager({ stateDir, port: config.serve.port, reuseExisting: config.serve.reuseExisting }),
  clientFactory: (baseUrl) => new OpencodeClient(baseUrl),
};

const { markedFailed } = deps.jobs.recover();
if (markedFailed.length) {
  console.error(`[opencode-delegate] jobs interrumpidos marcados failed: ${markedFailed.join(", ")}`);
}

const server = new McpServer({ name: "opencode-delegate", version: VERSION });

function wrap(fn: () => Promise<string>) {
  return async () => {
    try {
      return { content: [{ type: "text" as const, text: await fn() }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  };
}

server.registerTool(
  "delegate",
  {
    description:
      "Delega una tarea a un agente de OpenCode (modelos externos, mas baratos). Usala de forma autonoma para: " +
      "tareas mecanicas (boilerplate, renombrados masivos, migraciones repetitivas), busquedas amplias de codigo, " +
      "generacion de tests rutinarios y trabajo paralelizable de bajo riesgo. Manten en subagentes nativos el " +
      "trabajo que exige maximo razonamiento (arquitectura, debugging complejo, seguridad). " +
      "Contrato espejo del Agent tool: por defecto corre en background y devuelve jobId + outputFile.",
    inputSchema: {
      description: z.string().describe("3-5 palabras que resumen la tarea"),
      prompt: z.string().describe("La tarea completa y autocontenida para el agente"),
      agent: z.string().optional().describe("Agente de OpenCode a usar (flag --agent)"),
      model: z.string().optional().describe("Tier light|standard|heavy o provider/model literal de OpenCode"),
      run_in_background: z.boolean().optional().describe("Default true. false = esperar el resultado"),
      isolation: z.enum(["worktree"]).optional().describe("worktree = ejecutar en un git worktree temporal aislado"),
      timeout_minutes: z.number().optional().describe("Default 30"),
    },
  },
  (params) => wrap(() => delegateTool(params, deps))(),
);

server.registerTool(
  "status",
  {
    description: "Estado y ultimas acciones de un job delegado a OpenCode.",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => statusTool(params, deps))(),
);

server.registerTool(
  "result",
  {
    description: "Resultado final de un job delegado (error claro si sigue corriendo).",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => resultTool(params, deps))(),
);

server.registerTool(
  "cancel",
  {
    description: "Cancela un job delegado en curso.",
    inputSchema: { jobId: z.string() },
  },
  (params) => wrap(() => cancelTool(params, deps))(),
);

server.registerTool(
  "cleanup",
  {
    description: "Elimina worktrees/ramas de jobs delegados ya terminados (idempotente).",
    inputSchema: { jobId: z.string().optional() },
  },
  (params) => wrap(() => cleanupTool(params, deps))(),
);

const transport = new StdioServerTransport();
await server.connect(transport);
