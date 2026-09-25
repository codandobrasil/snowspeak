import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createProviders } from "./providers";

const base = { ACCESS_KEYS: "k", ALLOWED_ORIGINS: "chrome-extension://x" };

describe("createProviders", () => {
  it("usa o STT falso quando falta a chave", () => {
    expect(createProviders(loadConfig(base)).description).toBe("STT: falso (sem DEEPGRAM_API_KEY) · tradução: no Chrome do usuário");
  });

  it("usa o Deepgram quando a chave existe", () => {
    expect(createProviders(loadConfig({ ...base, DEEPGRAM_API_KEY: "dg" })).description).toBe("STT: Deepgram · tradução: no Chrome do usuário");
  });
});
