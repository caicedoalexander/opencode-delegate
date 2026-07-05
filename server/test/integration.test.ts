import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JobStore } from "../src/jobs.js";
import { loadConfig } from "../src/models.js";
import { OpencodeClient } from "../src/opencode-client.js";
import { ServeManager } from "../src/serve-manager.js";
import { delegateTool } from "../src/tools.js";

const enabled = process.env.OCD_INTEGRATION === "1";

describe.skipIf(!enabled)("integracion con opencode serve real", () => {
  it("delegate sincrono con modelo free devuelve texto", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "ocd-int-"));
    const stateDir = join(projectDir, ".opencode-delegate");
    const deps = {
      projectDir,
      config: loadConfig(projectDir, tmpdir()),
      jobs: new JobStore(join(stateDir, "jobs")),
      serve: new ServeManager({ stateDir, port: 4573, reuseExisting: true }),
      clientFactory: (baseUrl: string) => new OpencodeClient(baseUrl),
    };
    const out = await delegateTool(
      {
        description: "smoke integracion",
        prompt: "Responde exactamente: OK-INTEGRACION. Nada mas.",
        model: "light",
        run_in_background: false,
        timeout_minutes: 5,
      },
      deps,
    );
    expect(out).toContain("OK-INTEGRACION");
    await deps.serve.stopIfOwned();
  }, 300000);
});
