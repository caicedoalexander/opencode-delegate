import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DelegateConfig {
  defaultModel: string;
  tiers: { light: string; standard: string; heavy: string };
  serve: { port: number; reuseExisting: boolean };
}

export const DEFAULT_CONFIG: DelegateConfig = {
  defaultModel: "opencode-go/glm-5.2",
  tiers: {
    light: "opencode/deepseek-v4-flash-free",
    standard: "opencode-go/glm-5.2",
    heavy: "opencode-go/qwen3.7-max",
  },
  serve: { port: 4573, reuseExisting: true },
};

const TIERS = ["light", "standard", "heavy"] as const;
type Tier = (typeof TIERS)[number];

function readJsonIfExists(path: string): Partial<DelegateConfig> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<DelegateConfig>;
  } catch (err) {
    throw new Error(`Config invalida en ${path}: ${(err as Error).message}`);
  }
}

function mergeConfig(base: DelegateConfig, over: Partial<DelegateConfig> | undefined): DelegateConfig {
  if (!over) return base;
  return {
    defaultModel: over.defaultModel ?? base.defaultModel,
    tiers: { ...base.tiers, ...(over.tiers ?? {}) },
    serve: { ...base.serve, ...(over.serve ?? {}) },
  };
}

export function loadConfig(projectDir: string, homeDir: string): DelegateConfig {
  const userPath = join(homeDir, ".config", "opencode-delegate", "config.json");
  const projectPath = join(projectDir, ".opencode-delegate", "config.json");
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, readJsonIfExists(userPath)), readJsonIfExists(projectPath));
}

export function resolveModel(model: string | undefined, config: DelegateConfig): string {
  if (model === undefined) return config.defaultModel;
  if (model.includes("/")) return model;
  if ((TIERS as readonly string[]).includes(model)) return config.tiers[model as Tier];
  throw new Error(`Modelo desconocido: "${model}". Usa light|standard|heavy o provider/model.`);
}
