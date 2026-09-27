import { describe, expect, it, vi } from "vitest";
import { DEEPGRAM_CHECK_URL, OPENROUTER_CHECK_URL, checkDeepgramKey, checkOpenRouterKey, describeKeyCheck } from "./key-check";

const respond = (status: number) => vi.fn(async (_url: string, _init: RequestInit) => ({ status }));

describe("teste das chaves", () => {
  it("Deepgram: manda a chave aparada no cabeçalho Token e lê 200 como ok", async () => {
    const fetchImpl = respond(200);
    expect(await checkDeepgramKey("  dg-key\n", fetchImpl)).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(DEEPGRAM_CHECK_URL, { headers: { Authorization: "Token dg-key" } });
  });

  it("OpenRouter: manda a chave aparada como Bearer", async () => {
    const fetchImpl = respond(200);
    expect(await checkOpenRouterKey(" or-key ", fetchImpl)).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(OPENROUTER_CHECK_URL, { headers: { Authorization: "Bearer or-key" } });
  });

  it("401 e 403 são chave recusada; outros status, falha", async () => {
    expect(await checkDeepgramKey("k", respond(401))).toBe("rejected");
    expect(await checkOpenRouterKey("k", respond(403))).toBe("rejected");
    expect(await checkDeepgramKey("k", respond(500))).toBe("failed");
  });

  it("erro de rede é falha", async () => {
    const offline = vi.fn(async (_url: string, _init: RequestInit): Promise<{ status: number }> => {
      throw new TypeError("Failed to fetch");
    });
    expect(await checkOpenRouterKey("k", offline)).toBe("failed");
  });

  it("chave vazia (ou só espaços) não chama a rede", async () => {
    const fetchImpl = respond(200);
    expect(await checkDeepgramKey("   ", fetchImpl)).toBe("missing");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("descreve cada resultado em português", () => {
    expect(describeKeyCheck("Deepgram", "ok")).toBe("Deepgram: ok");
    expect(describeKeyCheck("OpenRouter", "rejected")).toBe("OpenRouter: chave recusada");
    expect(describeKeyCheck("Deepgram", "missing")).toBe("Deepgram: informe a chave (obrigatória)");
    expect(describeKeyCheck("OpenRouter", "missing")).toBe("OpenRouter: não configurada (sem sugestões)");
    expect(describeKeyCheck("Deepgram", "failed")).toBe("Deepgram: não foi possível testar agora (rede ou serviço fora do ar)");
  });
});
