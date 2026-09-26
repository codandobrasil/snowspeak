import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createProviders } from "./providers";

const base = { ACCESS_KEYS: "k", ALLOWED_ORIGINS: "chrome-extension://x" };

describe("createProviders", () => {
  it("usa o STT falso quando falta a chave", () => {
    expect(createProviders(loadConfig(base)).description).toBe("STT: falso (sem DEEPGRAM_API_KEY) · tradução: no Chrome do usuário · sugestões: falsas (sem OPENROUTER_API_KEY)");
  });

  it("usa o Deepgram quando a chave existe", () => {
    expect(createProviders(loadConfig({ ...base, DEEPGRAM_API_KEY: "dg" })).description).toBe(
      "STT: Deepgram · tradução: no Chrome do usuário · sugestões: falsas (sem OPENROUTER_API_KEY)",
    );
  });

  it("usa o OpenRouter com o modelo configurado quando a chave existe", () => {
    const config = loadConfig({ ...base, OPENROUTER_API_KEY: "or", SUGGESTION_MODEL: "anthropic/claude-sonnet-5" });
    expect(createProviders(config).description).toContain("sugestões: OpenRouter (anthropic/claude-sonnet-5)");
    expect(loadConfig(base).suggestionModel).toBe("anthropic/claude-haiku-4.5");
  });
});
