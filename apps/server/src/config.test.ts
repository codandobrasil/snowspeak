import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("lê listas separadas por vírgula e aplica padrões", () => {
    const config = loadConfig({ ACCESS_KEYS: " a , b ,", ALLOWED_ORIGINS: "chrome-extension://x" });
    expect(config.accessKeys).toEqual(new Set(["a", "b"]));
    expect(config.allowedOrigins).toEqual(new Set(["chrome-extension://x"]));
    expect(config.port).toBe(8787);
    expect(config.host).toBe("0.0.0.0");
    expect(config.authTimeoutMs).toBe(5000);
  });

  it("exige ACCESS_KEYS e ALLOWED_ORIGINS", () => {
    expect(() => loadConfig({ ALLOWED_ORIGINS: "chrome-extension://x" })).toThrow(/ACCESS_KEYS/);
    expect(() => loadConfig({ ACCESS_KEYS: "a" })).toThrow(/ALLOWED_ORIGINS/);
  });
});
