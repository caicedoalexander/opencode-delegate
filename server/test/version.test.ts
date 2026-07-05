import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("version", () => {
  it("expone la version del paquete", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
