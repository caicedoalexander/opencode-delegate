import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, resolveModel } from "../src/models.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "ocd-test-"));
}

describe("resolveModel", () => {
  it("devuelve defaultModel cuando no se pasa modelo", () => {
    expect(resolveModel(undefined, DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.defaultModel);
  });

  it("resuelve tiers por tabla", () => {
    expect(resolveModel("light", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.tiers.light);
    expect(resolveModel("heavy", DEFAULT_CONFIG)).toBe(DEFAULT_CONFIG.tiers.heavy);
  });

  it("acepta provider/model literal sin tocarlo", () => {
    expect(resolveModel("opencode-go/kimi-k2.7-code", DEFAULT_CONFIG)).toBe("opencode-go/kimi-k2.7-code");
  });

  it("lanza error con valor que no es tier ni literal", () => {
    expect(() => resolveModel("turbo", DEFAULT_CONFIG)).toThrow(/Modelo desconocido/);
  });
});

describe("loadConfig", () => {
  it("sin archivos devuelve defaults", () => {
    expect(loadConfig(tempDir(), tempDir())).toEqual(DEFAULT_CONFIG);
  });

  it("config de proyecto pisa la de usuario, que pisa defaults", () => {
    const home = tempDir();
    const project = tempDir();
    mkdirSync(join(home, ".config", "opencode-delegate"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode-delegate", "config.json"),
      JSON.stringify({ defaultModel: "user/model", tiers: { light: "user/light" } }),
    );
    mkdirSync(join(project, ".opencode-delegate"), { recursive: true });
    writeFileSync(
      join(project, ".opencode-delegate", "config.json"),
      JSON.stringify({ defaultModel: "project/model" }),
    );
    const cfg = loadConfig(project, home);
    expect(cfg.defaultModel).toBe("project/model");
    expect(cfg.tiers.light).toBe("user/light");
    expect(cfg.tiers.heavy).toBe(DEFAULT_CONFIG.tiers.heavy);
  });

  it("JSON invalido lanza error con la ruta del archivo", () => {
    const project = tempDir();
    mkdirSync(join(project, ".opencode-delegate"), { recursive: true });
    writeFileSync(join(project, ".opencode-delegate", "config.json"), "{no json");
    expect(() => loadConfig(project, tempDir())).toThrow(/config.json/);
  });
});
