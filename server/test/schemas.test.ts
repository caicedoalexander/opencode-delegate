import { describe, expect, it } from "vitest";
import { timeoutMinutesSchema } from "../src/schemas.js";

describe("timeoutMinutesSchema", () => {
  it("rechaza 0 (dispararia el timer de abort de inmediato)", () => {
    expect(timeoutMinutesSchema.safeParse(0).success).toBe(false);
  });

  it("rechaza negativos", () => {
    expect(timeoutMinutesSchema.safeParse(-5).success).toBe(false);
  });

  it("rechaza valores mayores a 1440 (24h, limite de setTimeout de Node)", () => {
    expect(timeoutMinutesSchema.safeParse(1441).success).toBe(false);
    expect(timeoutMinutesSchema.safeParse(999_999).success).toBe(false);
  });

  it("acepta un valor normal", () => {
    expect(timeoutMinutesSchema.safeParse(30).success).toBe(true);
  });

  it("acepta 1440 (limite inclusivo)", () => {
    expect(timeoutMinutesSchema.safeParse(1440).success).toBe(true);
  });

  it("acepta undefined (parametro opcional)", () => {
    expect(timeoutMinutesSchema.safeParse(undefined).success).toBe(true);
  });
});
