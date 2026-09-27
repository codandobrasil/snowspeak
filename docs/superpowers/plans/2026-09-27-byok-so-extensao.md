# SnowSpeak só-extensão (BYOK) — plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A extensão passa a funcionar sozinha, sem servidor: transcreve com a chave do Deepgram do usuário, sugere respostas com a chave do OpenRouter dele e sai pronta para a Chrome Web Store.

**Architecture:** O motor que rodava em `apps/server` (pipeline por canal, montagem de falas, frases, sugestões) vai para `packages/engine`. Um `LocalSession` roda esse motor dentro do documento offscreen e fala direto com o Deepgram (WebSocket do navegador, chave no subprotocolo) e com o OpenRouter (`fetch` em streaming). O `SessionController` chama o `LocalSession` direto, sem socket, e todo o código de retomada de sessão sai. A reconexão passa a ser a do stream do Deepgram, dentro do `ChannelPipeline`.

**Tech Stack:** TypeScript 7, pnpm 9 (workspaces), Vitest 5, Vite 8, Chrome MV3 (tabCapture, offscreen, sidePanel), zod sai do projeto.

**Spec:** `docs/superpowers/specs/2026-09-27-byok-so-extensao-design.md`

## Global Constraints

- Tudo em português do Brasil: textos da interface, comentários, mensagens de commit, docs.
- Todo commit termina com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (depois de uma linha em branco).
- A extensão só fala com `api.deepgram.com` e `openrouter.ai`. `host_permissions` = `https://api.deepgram.com/*`, `https://openrouter.ai/*`.
- As chaves ficam em `chrome.storage.local` nas chaves `deepgramKey`, `openRouterKey`, `suggestionModel`. Nunca em `chrome.storage.sync`, logs, mensagens de erro ou URLs.
- Modelo padrão das sugestões: `anthropic/claude-haiku-4.5`.
- `minimum_chrome_version` continua `116`.
- Deepgram: mesma URL e parâmetros de hoje (`nova-3`, `en` para `them`, `multi` para `me`, `linear16`, 16 kHz, `interim_results`, `smart_format`, `punctuate`, `endpointing=300`, `utterance_end_ms=1000`); KeepAlive a cada 4 s; descarte acima de 32 KB em `bufferedAmount`; até 10 frames pendentes enquanto abre; 5 s para abrir.
- Reconexão do Deepgram: esperas de 0,5, 1, 2, 4, 8 e 10 s (depois 10 s), por até 60 s contados da queda.
- Textos exatos:
  - `Não foi possível conectar ao Deepgram. Confira a chave em Configurações.`
  - `Informe a chave do Deepgram em Configurações.`
  - `Reconectando ao Deepgram…`
  - `A transcrição dos participantes parou: não foi possível reconectar ao Deepgram.` / `A transcrição da sua voz parou: não foi possível reconectar ao Deepgram.`
  - `O OpenRouter recusou a chave. Confira em Configurações.`
  - `Sugestões desligadas: informe a chave do OpenRouter.`
- Antes de cada commit: `pnpm test` e `pnpm typecheck` verdes na raiz.
- Cuidado no shell: nunca `pkill -f <padrão>` (já derrubou o shell desta sessão).

## Review Focus

- **Chave colada com espaços ou quebra de linha** → é aparada antes de ir ao Deepgram, ao OpenRouter e ao teste de chaves (teste em `key-check.test.ts`, Tarefa 7).
- **A chave nunca aparece na URL do WebSocket** → vai só no subprotocolo (teste em `deepgram-browser.test.ts`, Tarefa 3).
- **Parar enquanto o Deepgram ainda conecta** → o início pendente não trava e nada fica capturando (testes em `local-session.test.ts`, Tarefa 5, e `session-controller.test.ts`, Tarefa 6).
- **O Deepgram cai e volta mais de uma vez na mesma sessão** → cada queda gera um aviso e cada volta um "ok", e a numeração das falas continua (teste em `channel-pipeline.test.ts`, Tarefa 4).
- **Modelo inexistente no OpenRouter (HTTP 400)** → erro `provider`, não `unauthorized` (teste em `openrouter.test.ts`, Tarefa 2).

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `packages/engine/package.json`, `tsconfig.json`, `src/index.ts` | Pacote novo do motor |
| `packages/engine/src/{utterance-assembler,sentence-splitter,channel-sequencer,forward-clock,latency}.ts` | Movidos do servidor, sem mudança |
| `packages/engine/src/channel-pipeline.ts` | Um canal: frames → STT → falas → frases; **reconexão do Deepgram** e contadores |
| `packages/engine/src/stt/types.ts` | Contrato do STT (ganha `onOpen`) |
| `packages/engine/src/stt/deepgram-messages.ts` | Movido, sem mudança |
| `packages/engine/src/stt/deepgram-browser.ts` | **Novo**: cliente Deepgram com o WebSocket do navegador |
| `packages/engine/src/suggest/{prompt,question-detector,tag-stream}.ts` | Movidos, sem mudança |
| `packages/engine/src/suggest/suggestion-engine.ts` | Movido; erro `unauthorized` |
| `packages/engine/src/suggest/openrouter.ts` | Movido; leitura com `getReader`, `SuggesterAuthError`, modelo padrão |
| `packages/engine/src/local-session.ts` | **Novo**: a sessão inteira dentro do offscreen |
| `packages/engine/src/test-support/scripted-stt.ts` | STT roteirizado para testes (ganha `open()` e `streamsCreated`) |
| `packages/shared/src/messages.ts` | Só tipos: `EngineMessage`, `EngineEvent`, `EngineEventBody` |
| `packages/shared/src/audio-frame.ts` | Sem codificação binária |
| `apps/extension/src/offscreen/session-controller.ts` | Reescrito: sem socket, usa `EngineSession` |
| `apps/extension/src/offscreen/session-store.ts` | Sem retomada; `sttReconnecting`, `suggestionsEnabled` |
| `apps/extension/src/offscreen/main.ts` | Cria o `LocalSession` com as chaves |
| `apps/extension/src/sidepanel/key-check.ts` | **Novo**: testa as chaves |
| `apps/extension/src/sidepanel/main.ts`, `sidepanel.html` | Campos das chaves, Testar chaves, sugestões desligadas |
| `apps/extension/public/manifest.json`, `public/icons/*.png`, `icons-src/icon.svg` | Loja |
| `apps/extension/scripts/package.py` | Gera o `.zip` |
| `docs/loja/politica-de-privacidade.md`, `docs/loja/listagem.md` | Loja |
| Removidos | `apps/server/**`, `offscreen/socket.ts`, `offscreen/frame-sender{,.test}.ts`, `packages/shared/src/messages.test.ts` |

Observação sobre a ordem da spec: a spec põe "remover `apps/server`" na etapa 5, mas o servidor deixa de compilar assim que os módulos saem dele. Por isso a remoção acontece já na Tarefa 1. O README é atualizado na Tarefa 8.

---

### Task 1: Pacote `packages/engine` com os módulos do servidor

**Files:**
- Create: `packages/engine/package.json`, `packages/engine/tsconfig.json`, `packages/engine/src/index.ts`
- Move (git mv): módulos e testes listados no Step 1
- Delete: o restante de `apps/server/` (versionado)

**Interfaces:**
- Produces: pacote `@snowspeak/engine` (workspace) com `export { createOpenRouterSuggester, type Suggester }`, `type SuggestionSettings`, `type SttFactory`. Tarefas seguintes acrescentam exports.

- [ ] **Step 1: Mover os módulos puros e seus testes**

```bash
cd /home/marcelo/Documentos/SnowSpeak
mkdir -p packages/engine/src/stt packages/engine/src/suggest packages/engine/src/test-support
for f in utterance-assembler sentence-splitter channel-sequencer forward-clock latency channel-pipeline; do
  git mv apps/server/src/$f.ts apps/server/src/$f.test.ts packages/engine/src/
done
git mv apps/server/src/stt/types.ts packages/engine/src/stt/
git mv apps/server/src/stt/deepgram-messages.ts apps/server/src/stt/deepgram-messages.test.ts packages/engine/src/stt/
for f in prompt question-detector tag-stream suggestion-engine openrouter; do
  git mv apps/server/src/suggest/$f.ts apps/server/src/suggest/$f.test.ts packages/engine/src/suggest/
done
git mv apps/server/src/test-support/scripted-stt.ts packages/engine/src/test-support/
git rm -r -q apps/server
```

`git rm` deixa no disco o `apps/server/.env` (não versionado) e `apps/server/node_modules`. Não apague o `.env`: ele tem as chaves do usuário, que decide o que fazer com ele. Só remova a pasta de dependências: `rm -rf apps/server/node_modules`.

- [ ] **Step 2: Criar `packages/engine/package.json`**

```json
{
  "name": "@snowspeak/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@snowspeak/shared": "workspace:^"
  }
}
```

- [ ] **Step 3: Criar `packages/engine/tsconfig.json`**

O motor roda no navegador (DOM: `WebSocket`, `fetch`, `crypto`); os testes usam `node:http`.

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 4: Criar `packages/engine/src/index.ts`**

```ts
export { createOpenRouterSuggester, type Suggester } from "./suggest/openrouter";
export type { SuggestionSettings } from "./suggest/suggestion-engine";
export type { SttFactory } from "./stt/types";
```

- [ ] **Step 5: Reinstalar o workspace e rodar tudo**

```bash
pnpm install
pnpm test
pnpm typecheck
```

Expected: `pnpm install` remove `ws` e `tsx` do lockfile e liga `@snowspeak/engine`; testes e typecheck verdes (os testes movidos passam sem mudança, porque os caminhos relativos são os mesmos).

- [ ] **Step 6: Commit**

```bash
git add -A packages/engine apps/server pnpm-lock.yaml
git commit -m "refactor: motor vai para packages/engine e o servidor sai

Os módulos puros (falas, frases, sugestões, parser do Deepgram) e seus
testes passam para @snowspeak/engine; o restante de apps/server é
removido (continua no histórico, último commit com ele: 0706794).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: OpenRouter no navegador e chave recusada

**Files:**
- Modify: `packages/engine/src/suggest/openrouter.ts`
- Modify: `packages/engine/src/suggest/suggestion-engine.ts` (bloco `catch` de `run`)
- Modify: `packages/shared/src/messages.ts` (`SUGGESTION_ERROR_CODES`)
- Modify: `apps/extension/src/sidepanel/suggestion-view.ts` (`ERROR_MESSAGES`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/suggest/openrouter.test.ts`, `packages/engine/src/suggest/suggestion-engine.test.ts`, `apps/extension/src/sidepanel/suggestion-view.test.ts`

**Interfaces:**
- Produces: `class SuggesterAuthError extends Error` (`constructor(status: number)`), `DEFAULT_SUGGESTION_MODEL = "anthropic/claude-haiku-4.5"`, código `"unauthorized"` em `SUGGESTION_ERROR_CODES`. Sai `createFakeSuggester`.

- [ ] **Step 1: Testes que falham — status de recusa no OpenRouter**

Em `openrouter.test.ts`, troque o import por `import { SuggesterAuthError, createOpenRouterSuggester } from "./openrouter";` e acrescente dentro do `describe`:

```ts
  it("chave recusada (401 ou 403) vira SuggesterAuthError", async () => {
    for (const status of [401, 403]) {
      const url = await startFake((res) => res.writeHead(status, { "content-type": "application/json" }).end('{"error":{"message":"No auth"}}'));
      await expect(collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal))).rejects.toBeInstanceOf(
        SuggesterAuthError,
      );
      server?.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("modelo inexistente (400) é erro comum, não de chave", async () => {
    const url = await startFake((res) => res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"not a valid model"}}'));
    const run = collect(createOpenRouterSuggester({ apiKey: "k", model: "nao/existe", url }).stream([], new AbortController().signal));
    await expect(run).rejects.toThrow("400");
    await expect(run).rejects.not.toBeInstanceOf(SuggesterAuthError);
  });
```

Em `suggestion-engine.test.ts`, acrescente `import { SuggesterAuthError } from "./openrouter";` e, dentro do `describe` principal:

```ts
  it("chave recusada pelo OpenRouter vira erro unauthorized", async () => {
    const t = setup(async function* () {
      throw new SuggesterAuthError(401);
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "unauthorized" });
  });
```

Em `apps/extension/src/sidepanel/suggestion-view.test.ts`, no teste "explica cada erro em português", acrescente:

```ts
    expect(error("unauthorized")).toBe("O OpenRouter recusou a chave. Confira em Configurações.");
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run packages/engine/src/suggest apps/extension/src/sidepanel/suggestion-view.test.ts`
Expected: FAIL (`SuggesterAuthError` não existe; `"unauthorized"` não é um código válido).

- [ ] **Step 3: Implementar**

`packages/shared/src/messages.ts`:

```ts
export const SUGGESTION_ERROR_CODES = ["busy", "rate_limited", "timeout", "invalid_output", "provider", "unauthorized", "cancelled"] as const;
```

`packages/engine/src/suggest/openrouter.ts` (arquivo inteiro):

```ts
import type { ChatMessage } from "./prompt";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_SUGGESTION_MODEL = "anthropic/claude-haiku-4.5";

export interface Suggester {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
}

/** O OpenRouter recusou a chave do usuário (HTTP 401 ou 403). */
export class SuggesterAuthError extends Error {
  constructor(status: number) {
    super(`OpenRouter recusou a chave (HTTP ${status})`);
    this.name = "SuggesterAuthError";
  }
}

interface StreamChunk {
  error?: { message?: string };
  choices?: Array<{ delta?: { content?: unknown } }>;
}

export function createOpenRouterSuggester(options: { apiKey: string; model: string; url?: string }): Suggester {
  const url = options.url ?? OPENROUTER_URL;
  return {
    async *stream(messages, signal) {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json", "X-Title": "SnowSpeak" },
        body: JSON.stringify({ model: options.model, messages, stream: true, max_tokens: 400, temperature: 0.4 }),
        signal,
      });
      if (response.status === 401 || response.status === 403) throw new SuggesterAuthError(response.status);
      if (!response.ok || !response.body) throw new Error(`OpenRouter respondeu HTTP ${response.status}`);

      // getReader em vez de for await: a iteração assíncrona do corpo só existe em Chromes mais novos que o mínimo do manifesto.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            // Linhas vazias separam eventos; ":" são comentários (ex.: OPENROUTER PROCESSING).
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") return;
            const data = JSON.parse(payload) as StreamChunk;
            if (data.error) throw new Error(`OpenRouter: ${data.error.message ?? "erro no stream"}`);
            const content = data.choices?.[0]?.delta?.content;
            if (typeof content === "string" && content) yield content;
          }
        }
      } finally {
        // Fim antecipado (cancelamento, [DONE], erro): libera a conexão.
        reader.cancel().catch(() => undefined);
      }
    },
  };
}
```

`packages/engine/src/suggest/suggestion-engine.ts`: troque o import `import type { Suggester } from "./openrouter";` por `import { SuggesterAuthError, type Suggester } from "./openrouter";` e, em `run`, o bloco `catch`:

```ts
    } catch (error) {
      if (!generation.reason) {
        console.warn(`sugestão falhou: ${error instanceof Error ? error.message : String(error)}`);
        fail(error instanceof SuggesterAuthError ? "unauthorized" : "provider");
        return;
      }
    }
```

`apps/extension/src/sidepanel/suggestion-view.ts`, em `ERROR_MESSAGES`, depois de `provider`:

```ts
  unauthorized: "O OpenRouter recusou a chave. Confira em Configurações.",
```

`packages/engine/src/index.ts`, troque a primeira linha por:

```ts
export { DEFAULT_SUGGESTION_MODEL, SuggesterAuthError, createOpenRouterSuggester, type Suggester } from "./suggest/openrouter";
```

- [ ] **Step 4: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages apps/extension/src/sidepanel
git commit -m "feat(engine): OpenRouter lido com getReader e chave recusada como erro próprio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Cliente Deepgram com o WebSocket do navegador

**Files:**
- Create: `packages/engine/src/stt/deepgram-browser.ts`
- Modify: `packages/engine/src/stt/types.ts` (`SttCallbacks.onOpen`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/stt/deepgram-browser.test.ts`

**Interfaces:**
- Consumes: `parseDeepgramMessage(raw: string): SttResult | null` (`./deepgram-messages`), `SttFactory`/`SttCallbacks` (`./types`).
- Produces: `createDeepgramSttFactory(options: DeepgramOptions): SttFactory`, com `DeepgramOptions = { apiKey: string; baseUrl?: string; openTimeoutMs?: number; maxBufferedBytes?: number; keepAliveMs?: number; socketImpl?: BrowserSocketConstructor }`; `interface BrowserSocket`; `SttCallbacks.onOpen?(): void`.

- [ ] **Step 1: `onOpen` no contrato do STT**

Em `packages/engine/src/stt/types.ts`, dentro de `SttCallbacks`, antes de `onResult`:

```ts
  /** A conexão com o provedor abriu (antes disso, write() só enfileira). */
  onOpen?(): void;
```

- [ ] **Step 2: Escrever o teste que falha**

`packages/engine/src/stt/deepgram-browser.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeepgramSttFactory, type BrowserSocket, type DeepgramOptions } from "./deepgram-browser";
import type { SttResult } from "./types";

class FakeSocket implements BrowserSocket {
  static created: FakeSocket[] = [];
  binaryType: BinaryType = "blob";
  readyState = 0;
  bufferedAmount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: unknown[] = [];
  /** Código passado a close(); "none" quando chamado sem código. */
  closeCode: number | "none" | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.created.push(this);
  }

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === "string" ? data : Array.from(data as Uint8Array));
  }
  close(code?: number): void {
    this.closeCode = code ?? "none";
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  receive(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

function collect() {
  const state = { results: [] as SttResult[], errors: [] as Error[], opens: 0 };
  const callbacks = {
    onOpen: () => {
      state.opens += 1;
    },
    onResult: (result: SttResult) => {
      state.results.push(result);
    },
    onError: (error: Error) => {
      state.errors.push(error);
    },
  };
  return { state, callbacks };
}

const factory = (overrides: Partial<DeepgramOptions> = {}) => createDeepgramSttFactory({ apiKey: "dg-key", socketImpl: FakeSocket, ...overrides });
const last = (): FakeSocket => {
  const socket = FakeSocket.created.at(-1);
  if (!socket) throw new Error("nenhum socket criado");
  return socket;
};

afterEach(() => {
  FakeSocket.created = [];
  vi.useRealTimers();
});

describe("Deepgram no navegador", () => {
  it("conecta com a chave no subprotocolo e os parâmetros de cada canal, sem a chave na URL", () => {
    const f = factory();
    f("them", collect().callbacks);
    f("me", collect().callbacks);
    const [them, me] = FakeSocket.created;
    expect(them!.protocols).toEqual(["token", "dg-key"]);
    expect(them!.binaryType).toBe("arraybuffer");
    expect(them!.url).not.toContain("dg-key");
    const url = new URL(them!.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      model: "nova-3",
      language: "en",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      endpointing: "300",
      utterance_end_ms: "1000",
    });
    expect(new URL(me!.url).searchParams.get("language")).toBe("multi");
  });

  it("guarda o áudio até a conexão abrir, envia na ordem e avisa a abertura", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    stream.write(new Uint8Array([1, 2]));
    expect(last().sent).toEqual([]);
    last().open();
    stream.write(new Uint8Array([3, 4]));
    expect(last().sent).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(c.state.opens).toBe(1);
  });

  it("guarda no máximo 10 frames enquanto abre e conta os descartados", () => {
    const stream = factory()("them", collect().callbacks);
    for (let i = 0; i < 12; i++) stream.write(new Uint8Array([i, i]));
    last().open();
    expect(last().sent).toHaveLength(10);
    expect(last().sent[0]).toEqual([2, 2]);
    expect(stream.droppedFrames).toBe(2);
  });

  it("entrega os resultados interpretados", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().open();
    last().receive(JSON.stringify({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hello" }] } }));
    expect(c.state.results).toEqual([{ kind: "partial", text: "hello" }]);
  });

  it("envia Finalize e, ao fechar, CloseStream e fechamento normal, sem reportar erro", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    const socket = last();
    socket.open();
    stream.finalize();
    stream.close();
    expect(socket.sent).toEqual(['{"type":"Finalize"}', '{"type":"CloseStream"}']);
    expect(socket.closeCode).toBe(1000);
    socket.drop(1000);
    expect(c.state.errors).toEqual([]);
  });

  it("fechar antes de abrir não envia nada nem reporta erro", () => {
    const c = collect();
    const stream = factory()("them", c.callbacks);
    stream.write(new Uint8Array([1, 2]));
    stream.close();
    expect(last().closeCode).toBe("none");
    last().drop(1006);
    expect(last().sent).toEqual([]);
    expect(c.state.errors).toEqual([]);
  });

  it("avisa uma única vez quando a conexão cai", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().open();
    last().drop(1006);
    last().drop(1006);
    expect(c.state.errors.map((e) => e.message)).toEqual(["Deepgram encerrou a conexão (código 1006)"]);
  });

  it("avisa quando a conexão é recusada antes de abrir (chave errada ou rede fora)", () => {
    const c = collect();
    factory()("them", c.callbacks);
    last().drop(1006);
    expect(c.state.errors).toHaveLength(1);
    expect(c.state.opens).toBe(0);
  });

  it("desiste quando a conexão não abre no prazo", () => {
    vi.useFakeTimers();
    const c = collect();
    factory({ openTimeoutMs: 100 })("them", c.callbacks);
    vi.advanceTimersByTime(100);
    expect(c.state.errors[0]?.message).toContain("prazo");
    expect(last().closeCode).toBe("none");
  });

  it("descarta e conta o áudio quando a conexão congestiona", () => {
    const stream = factory({ maxBufferedBytes: 1_000 })("them", collect().callbacks);
    last().open();
    last().bufferedAmount = 1_001;
    stream.write(new Uint8Array(3_200));
    expect(stream.droppedFrames).toBe(1);
    expect(last().sent).toEqual([]);
  });

  it("mantém a conexão viva com KeepAlive quando o canal fica sem áudio", () => {
    vi.useFakeTimers();
    factory({ keepAliveMs: 50 })("me", collect().callbacks);
    last().open();
    vi.advanceTimersByTime(50);
    expect(last().sent).toContain('{"type":"KeepAlive"}');
  });

  it("não envia KeepAlive enquanto o áudio flui", () => {
    vi.useFakeTimers();
    const stream = factory({ keepAliveMs: 80 })("them", collect().callbacks);
    last().open();
    for (let i = 0; i < 10; i++) {
      stream.write(new Uint8Array(4));
      vi.advanceTimersByTime(20);
    }
    expect(last().sent).not.toContain('{"type":"KeepAlive"}');
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run packages/engine/src/stt/deepgram-browser.test.ts`
Expected: FAIL (`./deepgram-browser` não existe).

- [ ] **Step 4: Implementar `packages/engine/src/stt/deepgram-browser.ts`**

```ts
import type { Channel } from "@snowspeak/shared";
import { parseDeepgramMessage } from "./deepgram-messages";
import type { SttFactory } from "./types";

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
export const DEEPGRAM_OPEN_TIMEOUT_MS = 5_000;
// ~1 s de áudio (PCM16 16 kHz): acima disso a conexão está atrasada e o frame é descartado.
export const DEEPGRAM_MAX_BUFFERED_BYTES = 32 * 1024;
// O Deepgram fecha a conexão (NET-0001) após ~10 s sem áudio nem KeepAlive — ex.: canal "me" sem microfone.
export const DEEPGRAM_KEEPALIVE_MS = 4_000;
const MAX_PENDING_FRAMES = 10; // até 1 s de áudio enquanto a conexão abre
const CONNECTING = 0;
const OPEN = 1;

export function deepgramListenUrl(baseUrl: string, channel: Channel): string {
  const params = new URLSearchParams({
    model: "nova-3",
    // Participantes falam inglês; no microfone o usuário pode misturar português.
    language: channel === "them" ? "en" : "multi",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    endpointing: "300",
    utterance_end_ms: "1000",
  });
  return `${baseUrl}?${params.toString()}`;
}

/** A parte do WebSocket do navegador que o cliente usa (os testes passam uma versão falsa). */
export interface BrowserSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number): void;
}

export type BrowserSocketConstructor = new (url: string, protocols: string[]) => BrowserSocket;

export interface DeepgramOptions {
  apiKey: string;
  baseUrl?: string;
  openTimeoutMs?: number;
  maxBufferedBytes?: number;
  keepAliveMs?: number;
  /** Padrão: o WebSocket do navegador. */
  socketImpl?: BrowserSocketConstructor;
}

export function createDeepgramSttFactory(options: DeepgramOptions): SttFactory {
  const baseUrl = options.baseUrl ?? DEEPGRAM_URL;
  const openTimeoutMs = options.openTimeoutMs ?? DEEPGRAM_OPEN_TIMEOUT_MS;
  const maxBufferedBytes = options.maxBufferedBytes ?? DEEPGRAM_MAX_BUFFERED_BYTES;
  const keepAliveMs = options.keepAliveMs ?? DEEPGRAM_KEEPALIVE_MS;

  return (channel, callbacks) => {
    const Socket = options.socketImpl ?? (WebSocket as unknown as BrowserSocketConstructor);
    // O WebSocket do navegador não envia cabeçalhos: a chave vai no subprotocolo, como o Deepgram documenta.
    const ws = new Socket(deepgramListenUrl(baseUrl, channel), ["token", options.apiKey]);
    ws.binaryType = "arraybuffer";
    const pending: Uint8Array[] = [];
    let droppedFrames = 0;
    let lastSentAt = Date.now();
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let closedByUs = false;
    let failed = false;

    const stopTimers = (): void => {
      clearTimeout(openTimer);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    };

    const fail = (reason: string): void => {
      if (closedByUs || failed) return;
      failed = true;
      stopTimers();
      callbacks.onError(new Error(reason));
    };

    const openTimer = setTimeout(() => {
      fail(`Deepgram não abriu a conexão no prazo (${openTimeoutMs} ms)`);
      ws.close();
    }, openTimeoutMs);

    ws.onopen = () => {
      clearTimeout(openTimer);
      for (const pcm of pending.splice(0)) ws.send(pcm);
      lastSentAt = Date.now();
      keepAliveTimer = setInterval(() => {
        if (ws.readyState !== OPEN || Date.now() - lastSentAt < keepAliveMs) return;
        ws.send(JSON.stringify({ type: "KeepAlive" }));
        lastSentAt = Date.now();
      }, keepAliveMs);
      callbacks.onOpen?.();
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const result = parseDeepgramMessage(event.data);
      if (result) callbacks.onResult(result);
    };
    // O navegador não diz o motivo do erro (nem o status HTTP do handshake); o close vem logo depois e é ele que avisa.
    ws.onerror = () => undefined;
    ws.onclose = (event) => {
      stopTimers();
      if (droppedFrames > 0) console.warn(`Deepgram (${channel}): ${droppedFrames} frames descartados por congestionamento`);
      fail(`Deepgram encerrou a conexão (código ${event.code})`);
    };

    return {
      get droppedFrames() {
        return droppedFrames;
      },
      write(pcm) {
        if (ws.readyState === OPEN) {
          // Áudio atrasado não serve para legenda ao vivo: descarta em vez de acumular.
          if (ws.bufferedAmount > maxBufferedBytes) {
            droppedFrames += 1;
            return;
          }
          ws.send(pcm);
          lastSentAt = Date.now();
        } else if (ws.readyState === CONNECTING) {
          pending.push(pcm);
          if (pending.length > MAX_PENDING_FRAMES) {
            pending.shift();
            droppedFrames += 1;
          }
        }
      },
      finalize() {
        if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      close() {
        closedByUs = true;
        stopTimers();
        if (ws.readyState === OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else {
          ws.close();
        }
      },
    };
  };
}
```

Em `packages/engine/src/index.ts`, acrescente:

```ts
export { createDeepgramSttFactory } from "./stt/deepgram-browser";
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages/engine
git commit -m "feat(engine): cliente Deepgram com o WebSocket do navegador

A chave vai no subprotocolo [\"token\", chave], o único jeito de
autenticar sem cabeçalhos; o restante (KeepAlive, descarte por
congestionamento, prazo de abertura) segue o cliente do servidor.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reconexão do Deepgram no `ChannelPipeline`

**Files:**
- Modify: `packages/engine/src/channel-pipeline.ts` (reescrito, código abaixo)
- Modify: `packages/engine/src/test-support/scripted-stt.ts` (reescrito)
- Modify: `packages/shared/src/messages.ts` (evento `stt.status`)
- Modify: `apps/extension/src/offscreen/session-store.ts` (aviso de reconexão)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/channel-pipeline.test.ts` (reescrito), `apps/extension/src/offscreen/session-store.test.ts`

**Interfaces:**
- Consumes: `SttCallbacks.onOpen` (Tarefa 3).
- Produces:
  - `ChannelPipelineDeps.retryBeforeFirstOpen: boolean`
  - `ChannelPipeline.firstOpen: Promise<void>`, `stats(): ChannelStats`, `drain(): Promise<void>`, `close(): void`, `acceptFrame(frame: AudioFrame): boolean`. `suspend()` e `reopenStt()` saem.
  - `interface ChannelStats { sentFrames: number; droppedFrames: number }`
  - `STT_RECONNECT_DELAYS_MS`, `STT_RECONNECT_WINDOW_MS`
  - evento `{ type: "stt.status"; channel: Channel; state: "reconnecting" | "ok" }`; `STT_STATES`, `type SttState`
  - store: `SessionState.sttReconnecting: Record<Channel, boolean>`, `STT_RECONNECTING_NOTICE = "Reconectando ao Deepgram…"`
  - hub: `ScriptedChannel.open(): void`, `createScriptedSttHub().streamsCreated(channel): number`

- [ ] **Step 1: STT roteirizado com abertura e contagem de streams**

`packages/engine/src/test-support/scripted-stt.ts` (arquivo inteiro):

```ts
import type { Channel } from "@snowspeak/shared";
import type { SttFactory, SttResult } from "../stt/types";

export interface ScriptedChannel {
  /** O "provedor" abriu a conexão. */
  open(): void;
  emit(result: SttResult): void;
  fail(): void;
  writes: number;
  finalizes: number;
  closed: boolean;
  /** Chamado quando a sessão pede Finalize; o teste decide o que o "provedor" responde. */
  onFinalize: (() => void) | null;
}

export function createScriptedSttHub(): {
  factory: SttFactory;
  /** O stream mais recente do canal. */
  channel(channel: Channel): ScriptedChannel;
  /** Quantos streams o canal já abriu (a primeira conexão e as reconexões). */
  streamsCreated(channel: Channel): number;
} {
  const channels = new Map<Channel, ScriptedChannel>();
  const created = new Map<Channel, number>();
  const factory: SttFactory = (channel, callbacks) => {
    const state: ScriptedChannel = {
      open: () => callbacks.onOpen?.(),
      emit: (result) => callbacks.onResult(result),
      fail: () => callbacks.onError(new Error("falha roteirizada")),
      writes: 0,
      finalizes: 0,
      closed: false,
      onFinalize: null,
    };
    channels.set(channel, state);
    created.set(channel, (created.get(channel) ?? 0) + 1);
    return {
      droppedFrames: 0,
      write: () => {
        state.writes += 1;
      },
      finalize: () => {
        state.finalizes += 1;
        state.onFinalize?.();
      },
      close: () => {
        state.closed = true;
      },
    };
  };
  return {
    factory,
    channel(channel) {
      const state = channels.get(channel);
      if (!state) throw new Error(`nenhum STT aberto para ${channel}`);
      return state;
    },
    streamsCreated: (channel) => created.get(channel) ?? 0,
  };
}
```

- [ ] **Step 2: Evento `stt.status` no protocolo**

Em `packages/shared/src/messages.ts`, depois de `audioGapBody`:

```ts
export const STT_STATES = ["reconnecting", "ok"] as const;
export type SttState = (typeof STT_STATES)[number];

// Conexão com o Deepgram de um canal: caiu e está reconectando, ou voltou.
const sttStatusBody = z.object({
  type: z.literal("stt.status"),
  channel: channelSchema,
  state: z.enum(STT_STATES),
});
```

Na lista do `serverMessageSchema`, depois de `audioGapBody.extend(envelopeShape),`, acrescente `sttStatusBody.extend(envelopeShape),`. Em `ServerEventBody`, depois de `| z.infer<typeof audioGapBody>`, acrescente `| z.infer<typeof sttStatusBody>`.

- [ ] **Step 3: Testes que falham — pipeline**

`packages/engine/src/channel-pipeline.test.ts` (arquivo inteiro):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import { ChannelPipeline, STT_RECONNECT_DELAYS_MS } from "./channel-pipeline";
import { LatencyStats } from "./latency";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const frame = (frameSeq: number) => ({ channel: "them" as const, frameSeq, sampleOffset: frameSeq * 1600, pcm: new Uint8Array(3200) });

function setup(options: { retryBeforeFirstOpen?: boolean } = {}) {
  const hub = createScriptedSttHub();
  const events: ServerEventBody[] = [];
  const pipeline = new ChannelPipeline({
    channel: "them",
    sttFactory: hub.factory,
    splitSentences: false,
    emit: (body) => events.push(body),
    sttLatency: new LatencyStats(),
    now: () => Date.now(),
    retryBeforeFirstOpen: options.retryBeforeFirstOpen ?? false,
  });
  return { hub, events, pipeline };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChannelPipeline", () => {
  it("drain pede Finalize e fecha a fala aberta como interrompida", async () => {
    const { hub, events, pipeline } = setup();
    const them = hub.channel("them");
    them.open();
    pipeline.acceptFrame(frame(0));
    them.emit({ kind: "partial", text: "hel" });
    await pipeline.drain();
    expect(them.finalizes).toBe(1);
    expect(events.at(-1)).toEqual({ type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true });
  });

  it("firstOpen resolve na primeira abertura", async () => {
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    await expect(pipeline.firstOpen).resolves.toBeUndefined();
  });

  it("falha antes da primeira abertura sem retryBeforeFirstOpen: rejeita firstOpen e não tenta de novo", async () => {
    vi.useFakeTimers();
    const { hub, events, pipeline } = setup({ retryBeforeFirstOpen: false });
    hub.channel("them").fail();
    await expect(pipeline.firstOpen).rejects.toThrow("falha roteirizada");
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(1);
    expect(events).toEqual([]);
  });

  it("com retryBeforeFirstOpen, a falha inicial entra em reconexão", () => {
    vi.useFakeTimers();
    const { hub, events } = setup({ retryBeforeFirstOpen: true });
    hub.channel("them").fail();
    expect(events).toEqual([{ type: "stt.status", channel: "them", state: "reconnecting" }]);
    vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
    expect(hub.streamsCreated("them")).toBe(2);
  });

  it("queda com o stream aberto: fecha a fala, avisa, reabre com espera crescente e volta a transcrever", () => {
    vi.useFakeTimers();
    const { hub, events, pipeline } = setup();
    const first = hub.channel("them");
    first.open();
    first.emit({ kind: "partial", text: "and then" });
    first.fail();
    expect(events.slice(-2)).toEqual([
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true },
      { type: "stt.status", channel: "them", state: "reconnecting" },
    ]);
    // 100 ms de áudio chegam durante a queda e se perdem.
    pipeline.acceptFrame(frame(0));
    vi.advanceTimersByTime(499);
    expect(hub.streamsCreated("them")).toBe(1);
    vi.advanceTimersByTime(1);
    expect(hub.streamsCreated("them")).toBe(2);
    // A segunda tentativa também falha: a próxima vem 1 s depois.
    hub.channel("them").fail();
    vi.advanceTimersByTime(1_000);
    expect(hub.streamsCreated("them")).toBe(3);
    const fresh = hub.channel("them");
    fresh.open();
    expect(events.slice(-2)).toEqual([
      { type: "audio.gap", channel: "them", durationMs: 100, reason: "stt_unavailable" },
      { type: "stt.status", channel: "them", state: "ok" },
    ]);
    pipeline.acceptFrame(frame(1));
    expect(fresh.writes).toBe(1);
    fresh.emit({ kind: "segment", text: "Again", start: 0.1, end: 0.5, speechFinal: false, fromFinalize: false });
    fresh.emit({ kind: "utteranceEnd", lastWordEnd: 0.5 });
    expect(events.slice(-2)).toEqual([
      { type: "transcript.segment", channel: "them", utteranceId: "them-2", segmentIdx: 0, text: "Again" },
      { type: "utterance.end", channel: "them", utteranceId: "them-2", interrupted: false },
    ]);
  });

  it("cada queda gera um aviso e cada volta um ok", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    hub.channel("them").open();
    for (let i = 0; i < 2; i++) {
      hub.channel("them").fail();
      vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
      hub.channel("them").open();
    }
    expect(events.filter((e) => e.type === "stt.status")).toEqual([
      { type: "stt.status", channel: "them", state: "reconnecting" },
      { type: "stt.status", channel: "them", state: "ok" },
      { type: "stt.status", channel: "them", state: "reconnecting" },
      { type: "stt.status", channel: "them", state: "ok" },
    ]);
  });

  it("desiste 60 s depois da queda e avisa que a transcrição parou", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    hub.channel("them").open();
    hub.channel("them").fail();
    // 0,5 + 1 + 2 + 4 + 8 + 10 × 4 = 55,5 s; a próxima espera passaria de 60 s.
    for (const wait of [500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000, 10_000]) {
      vi.advanceTimersByTime(wait);
      hub.channel("them").fail();
    }
    expect(events.at(-1)).toEqual({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: "them",
      message: "A transcrição dos participantes parou: não foi possível reconectar ao Deepgram.",
    });
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(10);
  });

  it("close cancela a reconexão pendente", () => {
    vi.useFakeTimers();
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    hub.channel("them").fail();
    pipeline.close();
    vi.advanceTimersByTime(60_000);
    expect(hub.streamsCreated("them")).toBe(1);
  });

  it("ignora resultados atrasados do stream que caiu", () => {
    vi.useFakeTimers();
    const { hub, events } = setup();
    const old = hub.channel("them");
    old.open();
    old.fail();
    vi.advanceTimersByTime(STT_RECONNECT_DELAYS_MS[0]!);
    hub.channel("them").open();
    const before = events.length;
    old.emit({ kind: "segment", text: "Late words.", start: 44, end: 45, speechFinal: true, fromFinalize: false });
    expect(events.length).toBe(before);
  });

  it("conta frames enviados ao STT e descartados durante a queda", () => {
    vi.useFakeTimers();
    const { hub, pipeline } = setup();
    hub.channel("them").open();
    pipeline.acceptFrame(frame(0));
    hub.channel("them").fail();
    pipeline.acceptFrame(frame(1));
    expect(pipeline.stats()).toEqual({ sentFrames: 1, droppedFrames: 1 });
  });
});
```

Em `apps/extension/src/offscreen/session-store.test.ts`, acrescente `STT_RECONNECTING_NOTICE` ao import de `./session-store` e, no fim do `describe("reduce", …)`:

```ts
  it("mostra o aviso de reconexão do Deepgram enquanto algum canal reconecta", () => {
    const status = (seq: number, channel: "them" | "me", state: "reconnecting" | "ok"): StoreAction => ({
      type: "server",
      message: { v: 1, sessionId: "s1", seq, ts: 0, type: "stt.status", channel, state },
    });
    const state = run({ type: "server", message: started }, status(1, "them", "reconnecting"), status(2, "me", "reconnecting"), status(3, "them", "ok"));
    expect(state.notice).toBe(STT_RECONNECTING_NOTICE);
    expect(state.sttReconnecting).toEqual({ them: false, me: true });
    expect(reduce(state, status(4, "me", "ok")).notice).toBeNull();
  });

  it("a volta do Deepgram não apaga um aviso de outra origem", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: { v: 1, sessionId: "s1", seq: 1, ts: 0, type: "stt.status", channel: "them", state: "reconnecting" } },
      { type: "notice", message: "Tradução indisponível." },
      { type: "server", message: { v: 1, sessionId: "s1", seq: 2, ts: 0, type: "stt.status", channel: "them", state: "ok" } },
    );
    expect(state.notice).toBe("Tradução indisponível.");
  });
```

- [ ] **Step 4: Rodar e ver falhar**

Run: `pnpm vitest run packages/engine/src/channel-pipeline.test.ts apps/extension/src/offscreen/session-store.test.ts`
Expected: FAIL (`STT_RECONNECT_DELAYS_MS`, `retryBeforeFirstOpen`, `stats`, `STT_RECONNECTING_NOTICE` não existem).

- [ ] **Step 5: Implementar o pipeline**

`packages/engine/src/channel-pipeline.ts` (arquivo inteiro):

```ts
import { SAMPLE_RATE, frameSamples, samplesToMs, type AudioFrame, type Channel, type ServerEventBody } from "@snowspeak/shared";
import { ChannelSequencer } from "./channel-sequencer";
import { ForwardClock } from "./forward-clock";
import type { LatencyStats } from "./latency";
import { SentenceSplitter } from "./sentence-splitter";
import type { SttFactory, SttResult, SttStream } from "./stt/types";
import { UtteranceAssembler, type AssemblerOutput } from "./utterance-assembler";

export const FINALIZE_WAIT_MS = 500;
// Queda do Deepgram no meio da sessão: novas tentativas com espera crescente, por até 60 s contados da queda.
export const STT_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
export const STT_RECONNECT_WINDOW_MS = 60_000;

export interface ChannelStats {
  /** Frames entregues ao STT. */
  sentFrames: number;
  /** Frames descartados (conexão congestionada ou STT fora durante uma queda). */
  droppedFrames: number;
}

export interface ChannelPipelineDeps {
  channel: Channel;
  sttFactory: SttFactory;
  /** Canal them: divide as falas em frases para a tradução. */
  splitSentences: boolean;
  emit: (body: ServerEventBody) => void;
  sttLatency: LatencyStats;
  now: () => number;
  /** Cada fala encerrada, com o texto completo (ex.: para sugestões de resposta). */
  onUtterance?: (utterance: { channel: Channel; utteranceId: string; text: string; interrupted: boolean }) => void;
  /**
   * Falha antes da primeira abertura: false rejeita `firstOpen` e não tenta de novo (quem criou decide);
   * true entra em reconexão como uma queda qualquer.
   */
  retryBeforeFirstOpen: boolean;
}

interface Reconnect {
  since: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Áudio recebido sem STT para onde ir; vira audio.gap quando a queda termina. */
  lostSamples: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Um canal de áudio: continuidade dos frames → STT → falas → frases.
export class ChannelPipeline {
  /** Resolve na primeira abertura do STT; rejeita se ela falhar sem retryBeforeFirstOpen. */
  readonly firstOpen: Promise<void>;
  private settleFirstOpen: { resolve(): void; reject(error: Error): void } | null = null;
  private readonly sequencer = new ChannelSequencer();
  private readonly assembler: UtteranceAssembler;
  private readonly splitter: SentenceSplitter | null;
  private clock = new ForwardClock();
  private closed = false;
  private everOpened = false;
  private stt: SttStream | null;
  private reconnect: Reconnect | null = null;
  private audioForwarded = false;
  private sentFrames = 0;
  private droppedFrames = 0;
  private onFinalizeSettled: (() => void) | null = null;
  private readonly utteranceSegments = new Map<string, string[]>();

  constructor(private readonly deps: ChannelPipelineDeps) {
    this.firstOpen = new Promise<void>((resolve, reject) => {
      this.settleFirstOpen = { resolve, reject };
    });
    // Quem não espera a abertura (canal "me") não deve gerar rejeição não tratada.
    this.firstOpen.catch(() => undefined);
    this.assembler = new UtteranceAssembler(deps.channel);
    this.splitter = deps.splitSentences
      ? new SentenceSplitter((sentence) =>
          deps.emit({
            type: "sentence.ready",
            channel: deps.channel,
            utteranceId: sentence.utteranceId,
            sentenceIdx: sentence.sentenceIdx,
            text: sentence.text,
          }),
        )
      : null;
    this.stt = this.openStt();
  }

  private openStt(): SttStream {
    // Só o stream atual fala com o montador: resultados atrasados de um stream já fechado
    // (ex.: Deepgram esvaziando depois de uma queda) têm tempos de outra linha do tempo.
    const stream: SttStream = this.deps.sttFactory(this.deps.channel, {
      onOpen: () => {
        if (this.stt === stream) this.onSttOpen();
      },
      onResult: (result) => {
        if (this.stt === stream) this.onSttResult(result);
      },
      onError: (error) => {
        if (this.stt === stream) this.onSttError(error);
      },
    });
    return stream;
  }

  acceptFrame(frame: AudioFrame): boolean {
    const result = this.sequencer.accept(frame.frameSeq, frame.sampleOffset, frameSamples(frame));
    if (!result.accepted) return false;
    if (result.gapSamples > 0) {
      this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(result.gapSamples), reason: "client_drop" });
    }
    if (!this.stt) {
      this.droppedFrames += 1;
      if (this.reconnect) this.reconnect.lostSamples += frameSamples(frame);
      return true;
    }
    const droppedBefore = this.stt.droppedFrames;
    this.stt.write(frame.pcm);
    // Só entra na linha do tempo do STT o que ele de fato recebeu.
    if (this.stt.droppedFrames === droppedBefore) {
      this.sentFrames += 1;
      this.clock.record(frameSamples(frame), this.deps.now());
      this.audioForwarded = true;
    } else {
      this.droppedFrames += 1;
    }
    return true;
  }

  stats(): ChannelStats {
    return { sentFrames: this.sentFrames, droppedFrames: this.droppedFrames };
  }

  /**
   * Parar: se algum áudio foi enviado, pede ao STT o que falta (Finalize) e espera até 500 ms pela
   * resposta; o que continuar aberto fecha como interrompido.
   */
  async drain(): Promise<void> {
    if (this.stt && this.audioForwarded) {
      const settled = new Promise<void>((resolve) => {
        this.onFinalizeSettled = resolve;
      });
      this.stt.finalize();
      await Promise.race([settled, delay(FINALIZE_WAIT_MS)]);
      this.onFinalizeSettled = null;
    }
    this.handleAll(this.assembler.forceClose());
  }

  close(): void {
    this.closed = true;
    if (this.reconnect?.timer) clearTimeout(this.reconnect.timer);
    this.reconnect = null;
    this.splitter?.dispose();
    this.stt?.close();
    this.stt = null;
  }

  private onSttOpen(): void {
    this.everOpened = true;
    this.settleFirstOpen?.resolve();
    this.settleFirstOpen = null;
    const reconnect = this.reconnect;
    if (!reconnect) return;
    this.reconnect = null;
    this.emitLost(reconnect);
    this.deps.emit({ type: "stt.status", channel: this.deps.channel, state: "ok" });
  }

  private onSttResult(result: SttResult): void {
    if (result.kind === "segment" && result.text) {
      const forwardedAt = this.clock.forwardedAt(Math.round(result.end * SAMPLE_RATE));
      if (forwardedAt !== null) this.deps.sttLatency.add(this.deps.now() - forwardedAt);
    }
    this.handleAll(this.assembler.push(result));
    if (result.kind === "segment" && result.fromFinalize) this.onFinalizeSettled?.();
  }

  private onSttError(error: Error): void {
    if (!this.stt) return;
    this.stt.close();
    this.stt = null;
    this.handleAll(this.assembler.forceClose());
    this.onFinalizeSettled?.();
    if (!this.everOpened && !this.deps.retryBeforeFirstOpen) {
      this.settleFirstOpen?.reject(error);
      this.settleFirstOpen = null;
      return;
    }
    console.warn(`STT do canal ${this.deps.channel} caiu: ${error.message}`);
    if (!this.reconnect) {
      this.reconnect = { since: this.deps.now(), attempt: 0, timer: null, lostSamples: 0 };
      this.deps.emit({ type: "stt.status", channel: this.deps.channel, state: "reconnecting" });
    }
    this.scheduleReconnect(this.reconnect);
  }

  private scheduleReconnect(reconnect: Reconnect): void {
    const wait = STT_RECONNECT_DELAYS_MS[Math.min(reconnect.attempt, STT_RECONNECT_DELAYS_MS.length - 1)] ?? STT_RECONNECT_DELAYS_MS[0]!;
    if (this.deps.now() + wait - reconnect.since > STT_RECONNECT_WINDOW_MS) {
      this.giveUp(reconnect);
      return;
    }
    reconnect.attempt += 1;
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      if (this.closed || this.reconnect !== reconnect) return;
      // Stream novo: a linha do tempo do provedor recomeça do zero; falas e frases seguem a numeração.
      this.clock = new ForwardClock();
      this.assembler.resetTimeline();
      this.audioForwarded = false;
      this.stt = this.openStt();
    }, wait);
  }

  private giveUp(reconnect: Reconnect): void {
    this.reconnect = null;
    this.emitLost(reconnect);
    this.deps.emit({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: this.deps.channel,
      message: `A transcrição ${this.deps.channel === "them" ? "dos participantes" : "da sua voz"} parou: não foi possível reconectar ao Deepgram.`,
    });
  }

  private emitLost(reconnect: Reconnect): void {
    if (reconnect.lostSamples === 0) return;
    this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(reconnect.lostSamples), reason: "stt_unavailable" });
  }

  private handleAll(outputs: AssemblerOutput[]): void {
    for (const output of outputs) this.handle(output);
  }

  private handle(output: AssemblerOutput): void {
    this.deps.emit({ ...output, channel: this.deps.channel });
    if (output.type === "transcript.segment") {
      this.splitter?.addSegment(output.utteranceId, output.text);
      const segments = this.utteranceSegments.get(output.utteranceId) ?? [];
      segments.push(output.text);
      this.utteranceSegments.set(output.utteranceId, segments);
    }
    if (output.type === "utterance.end") {
      this.splitter?.endUtterance(output.utteranceId);
      const text = (this.utteranceSegments.get(output.utteranceId) ?? []).join(" ");
      this.utteranceSegments.delete(output.utteranceId);
      this.deps.onUtterance?.({ channel: this.deps.channel, utteranceId: output.utteranceId, text, interrupted: output.interrupted });
    }
  }
}
```

Em `packages/engine/src/index.ts`, acrescente:

```ts
export type { ChannelStats } from "./channel-pipeline";
```

- [ ] **Step 6: Implementar o aviso no store**

Em `apps/extension/src/offscreen/session-store.ts`:

1. Depois de `RATE_LIMITED_SUGGESTION_NOTICE`:

```ts
export const STT_RECONNECTING_NOTICE = "Reconectando ao Deepgram…";
```

2. Em `SessionState`, depois de `channels`:

```ts
  /** Canais cujo Deepgram caiu e está reconectando. */
  sttReconnecting: Record<Channel, boolean>;
```

3. Em `initialState()`, depois de `channels: …,`:

```ts
    sttReconnecting: { them: false, me: false },
```

4. Em `applyServerMessage`, depois do `case "audio.gap":`:

```ts
    case "stt.status": {
      const sttReconnecting = { ...next.sttReconnecting, [message.channel]: message.state === "reconnecting" };
      if (sttReconnecting.them || sttReconnecting.me) return { ...next, sttReconnecting, notice: STT_RECONNECTING_NOTICE };
      // Só apaga o aviso da reconexão; avisos de outra origem ficam.
      return { ...next, sttReconnecting, notice: next.notice === STT_RECONNECTING_NOTICE ? null : next.notice };
    }
```

- [ ] **Step 7: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A packages apps/extension/src/offscreen
git commit -m "feat(engine): reconexão do Deepgram por canal, com aviso e contadores

Uma queda fecha a fala aberta, emite stt.status reconnecting e tenta
de novo com espera crescente por até 60 s; a volta emite o áudio
perdido e stt.status ok. O painel mostra \"Reconectando ao Deepgram…\".

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `LocalSession` — a sessão dentro do offscreen

**Files:**
- Create: `packages/engine/src/local-session.ts`
- Modify: `packages/shared/src/messages.ts` (tipos `EngineControl`, `EngineMessage`, transitórios até a Tarefa 6)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/src/local-session.test.ts`

**Interfaces:**
- Consumes: `ChannelPipeline` (Tarefa 4), `SuggestionEngine`, `Suggester`.
- Produces:
  - `class LocalSession` com `constructor(deps: LocalSessionDeps, settings: SuggestionSettings)`, `readonly id: string`, `start(): Promise<void>`, `acceptPcm(channel: Channel, pcm: Uint8Array): void`, `stats(): Record<Channel, ChannelStats>`, `update(changes: Partial<SuggestionSettings>): void`, `requestSuggestion(requestId: string, question?: { utteranceId: string; text: string }): void`, `beginStop(): void`, `drain(): Promise<void>`, `close(reason: SessionEndReason): void`
  - `interface LocalSessionDeps { sttFactory: SttFactory; suggester: Suggester | null; onMessage: (message: EngineMessage) => void; now?: () => number }`
  - em `@snowspeak/shared`: `type EngineControl`, `type EngineMessage`

- [ ] **Step 1: Tipos transitórios em `packages/shared/src/messages.ts`**

No fim do arquivo (a Tarefa 6 reescreve o arquivo e estes tipos passam a ser os definitivos):

```ts
/** Mensagens de controle do motor local (sem resumeToken). */
export type EngineControl =
  | { v: 1; type: "session.started"; sessionId: string }
  | { v: 1; type: "session.ended"; sessionId: string; reason: SessionEndReason };

export type EngineMessage = EngineControl | ServerEvent;
```

- [ ] **Step 2: Escrever o teste que falha**

`packages/engine/src/local-session.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { EngineMessage } from "@snowspeak/shared";
import { LocalSession } from "./local-session";
import type { SttResult } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import type { ChatMessage } from "./suggest/prompt";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});
const finalSegment = (text: string): SttResult => segment(text, 0, 1, { speechFinal: true });

function recordingSuggester(script?: (signal: AbortSignal) => AsyncIterable<string>) {
  const calls: ChatMessage[][] = [];
  const suggester: Suggester = {
    stream: (messages, signal) => {
      calls.push(messages);
      if (script) return script(signal);
      return (async function* () {
        yield "<en>OK.</en>";
        yield "<pt>Certo.</pt>";
      })();
    },
  };
  return { suggester, calls };
}

// Só termina quando cancelado.
const hanging = (signal: AbortSignal): AsyncIterable<string> =>
  (async function* () {
    yield "<en>Partial";
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  })();

const SETTINGS = { mode: "interview" as const, context: "", profile: "Primeira versão", job: "" };
const pcm = (): Uint8Array => new Uint8Array(3200);

function create(suggester: Suggester | null = recordingSuggester().suggester) {
  const hub = createScriptedSttHub();
  const messages: EngineMessage[] = [];
  const session = new LocalSession({ sttFactory: hub.factory, suggester, onMessage: (message) => messages.push(message) }, SETTINGS);
  return {
    hub,
    session,
    messages,
    types: () => messages.map((m) => m.type),
    of: (type: EngineMessage["type"]) => messages.filter((m) => m.type === type),
  };
}

async function started(suggester?: Suggester | null) {
  const t = create(suggester);
  const starting = t.session.start();
  t.hub.channel("them").open();
  await starting;
  t.hub.channel("me").open();
  return t;
}

describe("LocalSession", () => {
  it("abre o Deepgram dos participantes, anuncia a sessão e só então abre o do microfone", async () => {
    const t = create();
    const starting = t.session.start();
    expect(t.hub.streamsCreated("them")).toBe(1);
    expect(t.hub.streamsCreated("me")).toBe(0);
    expect(t.messages).toEqual([]);
    t.hub.channel("them").open();
    await starting;
    expect(t.messages).toEqual([{ v: 1, type: "session.started", sessionId: t.session.id }]);
    expect(t.hub.streamsCreated("me")).toBe(1);
  });

  it("rejeita o início quando a primeira conexão dos participantes falha, sem anunciar nada", async () => {
    const t = create();
    const starting = t.session.start();
    t.hub.channel("them").fail();
    await expect(starting).rejects.toThrow("falha roteirizada");
    expect(t.messages).toEqual([]);
    expect(t.hub.channel("them").closed).toBe(true);
    expect(t.hub.streamsCreated("me")).toBe(0);
  });

  it("fechar durante o início rejeita o start e não emite nada", async () => {
    const t = create();
    const starting = t.session.start();
    t.session.close("stopped");
    await expect(starting).rejects.toThrow();
    expect(t.messages).toEqual([]);
    expect(t.hub.channel("them").closed).toBe(true);
  });

  it("transmite parcial, segmentos e fim de fala com o mesmo utteranceId", async () => {
    const t = await started();
    const them = t.hub.channel("them");
    them.emit({ kind: "partial", text: "hello" });
    them.emit(segment("Hello there.", 0, 0.8, { speechFinal: true }));
    expect(t.messages.filter((m) => m.type !== "session.started" && m.type !== "sentence.ready")).toMatchObject([
      { type: "transcript.partial", channel: "them", utteranceId: "them-1", text: "hello", seq: 1, sessionId: t.session.id },
      { type: "transcript.segment", channel: "them", utteranceId: "them-1", segmentIdx: 0, text: "Hello there." },
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("gera frases só para o canal dos participantes", async () => {
    const t = await started();
    t.hub.channel("me").emit(segment("Sure, sounds good.", 0, 1, { speechFinal: true }));
    t.hub.channel("them").emit(segment("Hello there.", 0, 0.8));
    expect(t.of("sentence.ready")).toMatchObject([{ channel: "them", utteranceId: "them-1", sentenceIdx: 0, text: "Hello there." }]);
  });

  it("ao parar, pede Finalize e entrega a fala e a frase antes de encerrar", async () => {
    const t = await started();
    const them = t.hub.channel("them");
    t.session.acceptPcm("them", pcm());
    them.emit({ kind: "partial", text: "almost do" });
    them.onFinalize = () => them.emit(segment("almost done", 0, 0.9, { fromFinalize: true }));
    t.session.beginStop();
    await t.session.drain();
    t.session.close("stopped");
    expect(them.finalizes).toBe(1);
    expect(t.types().filter((type) => type !== "session.started" && type !== "transcript.partial")).toEqual([
      "transcript.segment",
      "utterance.end",
      "sentence.ready",
      "session.ended",
    ]);
    expect(t.messages.at(-1)).toEqual({ v: 1, type: "session.ended", sessionId: t.session.id, reason: "stopped" });
    expect(them.closed).toBe(true);
  });

  it("ignora o áudio depois do início do Parar", async () => {
    const t = await started();
    t.session.beginStop();
    t.session.acceptPcm("them", pcm());
    expect(t.hub.channel("them").writes).toBe(0);
  });

  it("sem áudio enviado, parar não pede Finalize", async () => {
    const t = await started();
    await t.session.drain();
    expect(t.hub.channel("them").finalizes).toBe(0);
    expect(t.hub.channel("me").finalizes).toBe(0);
  });

  it("numera os frames de cada canal e conta o que foi ao Deepgram", async () => {
    const t = await started();
    t.session.acceptPcm("them", pcm());
    t.session.acceptPcm("them", pcm());
    t.session.acceptPcm("me", pcm());
    expect(t.hub.channel("them").writes).toBe(2);
    expect(t.session.stats()).toEqual({ them: { sentFrames: 2, droppedFrames: 0 }, me: { sentFrames: 1, droppedFrames: 0 } });
  });

  it("microfone que não conecta entra em reconexão sem derrubar a sessão", async () => {
    const t = create();
    const starting = t.session.start();
    t.hub.channel("them").open();
    await starting;
    t.hub.channel("me").fail();
    expect(t.of("stt.status")).toMatchObject([{ channel: "me", state: "reconnecting" }]);
    t.session.close("stopped");
  });

  it("pergunta do participante gera sugestão automática", async () => {
    const t = await started();
    t.hub.channel("them").emit(finalSegment("Tell me about yourself."));
    await vi.waitFor(() => expect(t.of("suggestion.done")).toHaveLength(1));
    expect(t.of("suggestion.done")[0]).toMatchObject({ en: "OK.", pt: "Certo." });
    expect(t.of("suggestion.started")[0]).toMatchObject({ trigger: "auto", basedOnUtteranceId: "them-1" });
  });

  it("requestSuggestion com a pergunta escolhida responde a ela", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    t.session.requestSuggestion("r1", { utteranceId: "them-7", text: "Why this company?" });
    await vi.waitFor(() => expect(t.of("suggestion.done")).toHaveLength(1));
    expect(t.of("suggestion.started")[0]).toMatchObject({ requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-7" });
    expect(r.calls[0]?.[1]?.content).toContain("QUESTION TO ANSWER:\nWhy this company?");
  });

  it("update muda o currículo usado nas próximas sugestões", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    t.session.update({ profile: "Kafka expert at Nubank" });
    t.session.requestSuggestion("r1");
    await vi.waitFor(() => expect(r.calls).toHaveLength(1));
    const prompt = r.calls[0]?.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Kafka expert at Nubank");
    expect(prompt).not.toContain("Primeira versão");
  });

  it("fechar cancela a sugestão em andamento e session.ended é a última mensagem", async () => {
    const t = await started(recordingSuggester(hanging).suggester);
    t.session.requestSuggestion("r1");
    expect(t.of("suggestion.started")).toHaveLength(1);
    t.session.close("stopped");
    expect(t.of("suggestion.error")).toMatchObject([{ requestId: "r1", code: "cancelled" }]);
    expect(t.types().at(-1)).toBe("session.ended");
  });

  it("uma pergunta finalizada durante o Parar não gera sugestão", async () => {
    const r = recordingSuggester();
    const t = await started(r.suggester);
    const them = t.hub.channel("them");
    t.session.acceptPcm("them", pcm());
    them.emit({ kind: "partial", text: "tell me about" });
    them.onFinalize = () => them.emit(segment("Tell me about yourself.", 0, 1, { fromFinalize: true }));
    t.session.beginStop();
    await t.session.drain();
    expect(t.types()).not.toContain("suggestion.started");
    expect(r.calls).toHaveLength(0);
  });

  it("sem suggester, não há sugestão automática nem a pedido", async () => {
    const t = await started(null);
    t.hub.channel("them").emit(finalSegment("Tell me about yourself."));
    t.session.requestSuggestion("r1");
    expect(t.types().filter((type) => type.startsWith("suggestion."))).toEqual([]);
  });
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `pnpm vitest run packages/engine/src/local-session.test.ts`
Expected: FAIL (`./local-session` não existe).

- [ ] **Step 4: Implementar `packages/engine/src/local-session.ts`**

```ts
import type { Channel, EngineMessage, ServerEvent, ServerEventBody, SessionEndReason } from "@snowspeak/shared";
import { ChannelPipeline, type ChannelStats } from "./channel-pipeline";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { SuggestionEngine, type SuggestionSettings } from "./suggest/suggestion-engine";

export interface LocalSessionDeps {
  sttFactory: SttFactory;
  /** null: sem chave do OpenRouter, a sessão não gera sugestões. */
  suggester: Suggester | null;
  onMessage: (message: EngineMessage) => void;
  now?: () => number;
}

interface FrameCounters {
  frameSeq: number;
  sampleOffset: number;
}

const NO_STATS: ChannelStats = { sentFrames: 0, droppedFrames: 0 };

// A sessão inteira, dentro do offscreen: áudio → Deepgram → falas e frases → sugestões.
export class LocalSession {
  readonly id = crypto.randomUUID();
  private seq = 0;
  private started = false;
  private stopping = false;
  private closed = false;
  private cancelStart: (() => void) | null = null;
  private settings: SuggestionSettings;
  private readonly now: () => number;
  private readonly sttLatency = new LatencyStats();
  private readonly engine: SuggestionEngine | null;
  private readonly pipelines: Partial<Record<Channel, ChannelPipeline>> = {};
  private readonly counters: Record<Channel, FrameCounters> = { them: { frameSeq: 0, sampleOffset: 0 }, me: { frameSeq: 0, sampleOffset: 0 } };

  constructor(
    private readonly deps: LocalSessionDeps,
    settings: SuggestionSettings,
  ) {
    this.now = deps.now ?? Date.now;
    this.settings = { ...settings };
    this.engine = deps.suggester
      ? new SuggestionEngine({
          suggester: deps.suggester,
          emit: (body) => this.emit(body),
          settings: () => ({ ...this.settings }),
          now: this.now,
        })
      : null;
  }

  /**
   * Abre o Deepgram dos participantes e anuncia a sessão; rejeita se essa primeira conexão falhar
   * (chave errada ou rede fora) ou se a sessão for fechada antes. O microfone abre depois e, se falhar,
   * entra em reconexão sem derrubar a sessão.
   */
  async start(): Promise<void> {
    const them = this.createPipeline("them", false);
    this.pipelines.them = them;
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelStart = () => reject(new Error("sessão encerrada antes de começar"));
    });
    try {
      await Promise.race([them.firstOpen, cancelled]);
    } catch (error) {
      this.close("error");
      throw error;
    } finally {
      this.cancelStart = null;
    }
    this.started = true;
    this.deps.onMessage({ v: 1, type: "session.started", sessionId: this.id });
    this.pipelines.me = this.createPipeline("me", true);
  }

  acceptPcm(channel: Channel, pcm: Uint8Array): void {
    const pipeline = this.pipelines[channel];
    if (!this.started || this.stopping || this.closed || !pipeline) return;
    const counters = this.counters[channel];
    pipeline.acceptFrame({ channel, frameSeq: counters.frameSeq, sampleOffset: counters.sampleOffset, pcm });
    counters.frameSeq += 1;
    counters.sampleOffset += pcm.byteLength / 2;
  }

  stats(): Record<Channel, ChannelStats> {
    return { them: this.pipelines.them?.stats() ?? NO_STATS, me: this.pipelines.me?.stats() ?? NO_STATS };
  }

  /** Modo, contexto, currículo e vaga valem para as próximas sugestões. */
  update(changes: Partial<SuggestionSettings>): void {
    const defined = Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined));
    this.settings = { ...this.settings, ...defined };
  }

  requestSuggestion(requestId: string, question?: { utteranceId: string; text: string }): void {
    this.engine?.request(requestId, question);
  }

  /** Início do Parar: a conversa segue sendo registrada, mas sem áudio novo nem sugestões novas. */
  beginStop(): void {
    this.stopping = true;
    this.engine?.stopAccepting();
  }

  async drain(): Promise<void> {
    await Promise.all(Object.values(this.pipelines).map((pipeline) => pipeline.drain()));
  }

  close(reason: SessionEndReason): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelStart?.();
    // A sugestão cancelada é avisada antes do fim da sessão.
    this.engine?.close();
    for (const pipeline of Object.values(this.pipelines)) pipeline.close();
    if (!this.started) return;
    this.deps.onMessage({ v: 1, type: "session.ended", sessionId: this.id, reason });
    console.info(`sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("latência estimada do STT (segmento final)", this.sttLatency)}`);
  }

  private createPipeline(channel: Channel, retryBeforeFirstOpen: boolean): ChannelPipeline {
    return new ChannelPipeline({
      channel,
      sttFactory: this.deps.sttFactory,
      splitSentences: channel === "them",
      emit: (body) => this.emit(body),
      sttLatency: this.sttLatency,
      now: this.now,
      onUtterance: (utterance) => this.engine?.addUtterance(utterance),
      retryBeforeFirstOpen,
    });
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.onMessage({ v: 1, sessionId: this.id, seq: this.seq, ts: this.now(), ...body } as ServerEvent);
  }
}
```

Em `packages/engine/src/index.ts`, acrescente:

```ts
export { LocalSession, type LocalSessionDeps } from "./local-session";
```

- [ ] **Step 5: Rodar e ver passar**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A packages
git commit -m "feat(engine): LocalSession roda a sessão inteira no offscreen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Extensão usa o motor local (sem socket)

**Files:**
- Modify: `packages/shared/src/messages.ts` (reescrito: só tipos), `packages/shared/src/audio-frame.ts`, `packages/shared/src/audio-frame.test.ts`, `packages/shared/package.json` (sai `zod`)
- Delete: `packages/shared/src/messages.test.ts`, `apps/extension/src/offscreen/socket.ts`, `apps/extension/src/offscreen/frame-sender.ts`, `apps/extension/src/offscreen/frame-sender.test.ts`
- Modify (renomeação em massa): todos os `.ts` de `packages/` e `apps/extension/src/`
- Modify: `apps/extension/src/offscreen/session-controller.ts` (reescrito), `session-controller.test.ts` (reescrito)
- Modify: `apps/extension/src/offscreen/session-store.ts`, `session-store.test.ts`, `translation-queue.ts`, `translation-queue.test.ts`, `message-handler.test.ts`, `main.ts`
- Modify: `apps/extension/src/sidepanel/panel-view.ts`, `panel-view.test.ts`, `main.ts`, `apps/extension/sidepanel.html`
- Modify: `apps/extension/package.json` (dependência `@snowspeak/engine`), `apps/extension/public/manifest.json` (`host_permissions`)

**Interfaces:**
- Consumes: `LocalSession`, `createDeepgramSttFactory`, `createOpenRouterSuggester`, `DEFAULT_SUGGESTION_MODEL`, `ChannelStats` de `@snowspeak/engine`.
- Produces:
  - `@snowspeak/shared`: `EngineMessage`, `EngineEvent`, `EngineEventBody`, `EngineControl`, `isEngineEvent()`; `SESSION_END_REASONS = ["stopped", "error"]`.
  - `StartParams = { streamId; deepgramKey; openRouterKey; suggestionModel; mode; context; profile; job }`
  - `interface EngineSession` (métodos do `LocalSession`), `ControllerDeps.createSession(params, onMessage): EngineSession`, `ControllerDeps.onEngineMessage?`
  - `DEEPGRAM_UNAVAILABLE_MESSAGE`, `TAB_CAPTURE_ENDED_MESSAGE`
  - store: ação `{ type: "engine"; message: EngineMessage }` (no lugar de `"server"`), `{ type: "starting"; suggestionsEnabled: boolean }`, `SessionState.suggestionsEnabled`; saem `resumeToken`, status e ação `reconnecting`.

- [ ] **Step 1: Reescrever `packages/shared/src/messages.ts` (só tipos)**

```ts
import type { Channel } from "./audio-frame";

export const MODES = ["work", "sales", "interview", "relationship"] as const;
export type Mode = (typeof MODES)[number];
export const MAX_CONTEXT_CHARS = 2_000;
export const MAX_PROFILE_CHARS = 8_000;
export const MAX_JOB_CHARS = 8_000;
export const MAX_QUESTION_CHARS = 2_000;

export const SESSION_END_REASONS = ["stopped", "error"] as const;
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export const AUDIO_GAP_REASONS = ["client_drop", "stt_unavailable"] as const;
export type AudioGapReason = (typeof AUDIO_GAP_REASONS)[number];

export const STT_STATES = ["reconnecting", "ok"] as const;
export type SttState = (typeof STT_STATES)[number];

export const ERROR_SCOPES = ["stt", "translate", "suggest", "session"] as const;
export type ErrorScope = (typeof ERROR_SCOPES)[number];
export const SUGGESTION_TRIGGERS = ["auto", "manual"] as const;
export type SuggestionTrigger = (typeof SUGGESTION_TRIGGERS)[number];
export const SUGGESTION_ERROR_CODES = ["busy", "rate_limited", "timeout", "invalid_output", "provider", "unauthorized", "cancelled"] as const;
export type SuggestionErrorCode = (typeof SUGGESTION_ERROR_CODES)[number];

// Mensagens de controle: sem seq.
export type EngineControl =
  | { v: 1; type: "session.started"; sessionId: string }
  | { v: 1; type: "session.ended"; sessionId: string; reason: SessionEndReason };

// Eventos: envelope com seq monotônico.
export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
}

export type EngineEventBody =
  | { type: "transcript.partial"; channel: Channel; utteranceId: string; text: string }
  | { type: "transcript.segment"; channel: Channel; utteranceId: string; segmentIdx: number; text: string }
  | { type: "utterance.end"; channel: Channel; utteranceId: string; interrupted: boolean }
  /** Frase do canal them pronta para tradução (a tradução acontece no offscreen). */
  | { type: "sentence.ready"; channel: Channel; utteranceId: string; sentenceIdx: number; text: string }
  | { type: "audio.gap"; channel: Channel; durationMs: number; reason: AudioGapReason }
  /** Conexão com o Deepgram de um canal: caiu e está reconectando, ou voltou. */
  | { type: "stt.status"; channel: Channel; state: SttState }
  | { type: "error"; scope: ErrorScope; code: string; retryable: boolean; message: string; channel?: Channel }
  | { type: "suggestion.started"; requestId: string; trigger: SuggestionTrigger; basedOnUtteranceId: string | null }
  | { type: "suggestion.delta"; requestId: string; lang: "en" | "pt"; text: string }
  | { type: "suggestion.done"; requestId: string; en: string; pt: string }
  | { type: "suggestion.error"; requestId: string; code: SuggestionErrorCode };

export type EngineEvent = EventEnvelope & EngineEventBody;

export type EngineMessage = EngineControl | EngineEvent;

export function isEngineEvent(message: EngineMessage): message is EngineEvent {
  return "seq" in message;
}
```

- [ ] **Step 2: Enxugar `audio-frame` e remover o que só servia à rede**

`packages/shared/src/audio-frame.ts` (arquivo inteiro):

```ts
export const SAMPLE_RATE = 16_000;

export type Channel = "them" | "me";

export interface AudioFrame {
  channel: Channel;
  frameSeq: number;
  sampleOffset: number;
  pcm: Uint8Array;
}

export function frameSamples(frame: AudioFrame): number {
  return frame.pcm.byteLength / 2;
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE;
}
```

`packages/shared/src/audio-frame.test.ts` (arquivo inteiro):

```ts
import { describe, expect, it } from "vitest";
import { frameSamples, samplesToMs, type AudioFrame } from "./audio-frame";

describe("audio-frame", () => {
  it("calcula samples e milissegundos, inclusive de um frame final curto", () => {
    const frame: AudioFrame = { channel: "them", frameSeq: 0, sampleOffset: 0, pcm: new Uint8Array(800) };
    expect(frameSamples(frame)).toBe(400);
    expect(samplesToMs(400)).toBe(25);
    expect(samplesToMs(1600)).toBe(100);
  });
});
```

```bash
git rm -q packages/shared/src/messages.test.ts apps/extension/src/offscreen/socket.ts apps/extension/src/offscreen/frame-sender.ts apps/extension/src/offscreen/frame-sender.test.ts
pnpm --filter @snowspeak/shared remove zod
pnpm --filter @snowspeak/extension add @snowspeak/engine@workspace:^
```

- [ ] **Step 3: Renomear os tipos e a ação do store em todo o código**

```bash
grep -rlE "ServerEventBody|ServerEvent|ServerMessage|isServerEvent|applyServerMessage|type: \"server\"" packages apps/extension/src --include=*.ts \
  | xargs perl -pi -e 's/\bServerEventBody\b/EngineEventBody/g; s/\bServerEvent\b/EngineEvent/g; s/\bServerMessage\b/EngineMessage/g; s/\bisServerEvent\b/isEngineEvent/g; s/\bapplyServerMessage\b/applyEngineMessage/g; s/type: "server"/type: "engine"/g'
grep -rlE 'resumeToken: "r1?"' apps/extension/src --include=*.ts | xargs perl -pi -e 's/, resumeToken: "r1?"//g'
grep -rl '{ type: "starting" }' apps/extension/src --include=*.ts | xargs perl -pi -e 's/\{ type: "starting" \}/{ type: "starting", suggestionsEnabled: true }/g'
```

A primeira substituição também troca o `import type { ServerEventBody }` dos arquivos do motor. Na Tarefa 5, `local-session.ts` importou `ServerEvent` e `EngineMessage` juntos; depois do `perl`, confira que o import não ficou com `EngineMessage` repetido e corrija à mão se ficou.

- [ ] **Step 4: Store sem retomada, com `suggestionsEnabled`**

Em `apps/extension/src/offscreen/session-store.ts`:

1. Imports (topo do arquivo):

```ts
import type { ChannelStats } from "@snowspeak/engine";
import { isEngineEvent, type Channel, type EngineMessage, type SuggestionErrorCode, type SuggestionTrigger } from "@snowspeak/shared";
```

2. `SessionStatus`:

```ts
export type SessionStatus = "idle" | "starting" | "running" | "stopping" | "error";
```

3. Em `SessionState`, remova `resumeToken: string | null;` e acrescente depois de `suggestionNotice`:

```ts
  /** Sessão com a chave do OpenRouter: sem ela, não há sugestões. */
  suggestionsEnabled: boolean;
```

4. Em `StoreAction`, troque `| { type: "starting" }` por `| { type: "starting"; suggestionsEnabled: boolean }` e remova as linhas da ação `reconnecting` (o comentário e `| { type: "reconnecting" }`).

5. Em `initialState()`, remova `resumeToken: null,` e acrescente `suggestionsEnabled: true,` depois de `suggestionNotice: null,`.

6. O começo de `applyEngineMessage` (o bloco de mensagens de controle) passa a ser:

```ts
function applyEngineMessage(state: SessionState, message: EngineMessage): SessionState {
  if (!isEngineEvent(message)) {
    if (message.type === "session.started") return { ...state, status: "running", sessionId: message.sessionId, lastSeq: 0 };
    return { ...state, status: "idle", channels: silenced(state) };
  }
```

7. Em `reduce`:

```ts
    case "starting":
      return { ...initialState(), status: "starting", suggestionsEnabled: action.suggestionsEnabled };
```

Remova o `case "reconnecting":`.

- [ ] **Step 5: Testes do store**

Em `apps/extension/src/offscreen/session-store.test.ts`, apague os testes "guarda o resumeToken, vai para reconectando sem perder a legenda e volta com session.resumed" e "heartbeat e session.superseded não mudam o estado", e acrescente no `describe("reduce", …)`:

```ts
  it("starting guarda se esta sessão tem sugestões", () => {
    expect(initialState().suggestionsEnabled).toBe(true);
    expect(run({ type: "starting", suggestionsEnabled: false }).suggestionsEnabled).toBe(false);
  });
```

No teste "soma a duração das lacunas de áudio por canal", o motivo `client_drop` continua válido.

- [ ] **Step 6: `StartParams` e o controlador reescrito**

`apps/extension/src/offscreen/session-controller.ts` (arquivo inteiro):

```ts
import type { ChannelStats } from "@snowspeak/engine";
import type { Channel, EngineMessage, Mode, SessionEndReason } from "@snowspeak/shared";
import type { SessionStore } from "./session-store";

export const STATS_INTERVAL_MS = 500;
// O offscreen não exibe pedido de permissão; se o getUserMedia do microfone ficar pendente, segue sem ele.
export const MIC_CAPTURE_TIMEOUT_MS = 3_000;
// Parar espera o Deepgram entregar as últimas falas; depois disso fecha mesmo assim.
export const STOP_TIMEOUT_MS = 3_000;

export const DEEPGRAM_UNAVAILABLE_MESSAGE = "Não foi possível conectar ao Deepgram. Confira a chave em Configurações.";
export const TAB_CAPTURE_ENDED_MESSAGE = "A captura da aba terminou (aba fechada ou compartilhamento encerrado).";

export interface StartParams {
  streamId: string;
  deepgramKey: string;
  /** Vazia: sessão sem sugestões. */
  openRouterKey: string;
  suggestionModel: string;
  mode: Mode;
  context: string;
  profile: string;
  job: string;
}

/** Pergunta que o usuário escolheu no painel. */
export interface SuggestionQuestion {
  utteranceId: string;
  text: string;
}

/** Campos que podem mudar durante a sessão (valem para as próximas sugestões). */
export type SessionSettingsChanges = Partial<Pick<StartParams, "mode" | "context" | "profile" | "job">>;

export interface ChannelCapture {
  stop(): void;
}

export interface CaptureCallbacks {
  onFrame(channel: Channel, pcm: ArrayBuffer): void;
  onLevel(channel: Channel, rms: number): void;
  /** A trilha terminou por fora (aba fechada, compartilhamento encerrado, microfone desconectado). */
  onEnded(channel: Channel): void;
}

/** A sessão do motor (LocalSession no offscreen; uma versão falsa nos testes). */
export interface EngineSession {
  /** Resolve quando o Deepgram dos participantes abre; rejeita se ele recusar ou se a sessão fechar antes. */
  start(): Promise<void>;
  acceptPcm(channel: Channel, pcm: Uint8Array): void;
  stats(): Record<Channel, ChannelStats>;
  update(changes: SessionSettingsChanges): void;
  requestSuggestion(requestId: string, question?: SuggestionQuestion): void;
  beginStop(): void;
  drain(): Promise<void>;
  close(reason: SessionEndReason): void;
}

export interface ControllerDeps {
  store: SessionStore;
  captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture>;
  captureMic(cb: CaptureCallbacks): Promise<ChannelCapture>;
  /** Cria a sessão com as chaves de `params`; as mensagens dela chegam por `onMessage`. */
  createSession(params: StartParams, onMessage: (message: EngineMessage) => void): EngineSession;
  /** Recebe cada mensagem do motor depois que ela foi aplicada ao store (ex.: fila de tradução). */
  onEngineMessage?: (message: EngineMessage) => void;
  /** Gera o requestId de cada pedido de sugestão (padrão: crypto.randomUUID). */
  newRequestId?: () => string;
}

interface Run {
  params: StartParams;
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  session: EngineSession | null;
  /** O Deepgram dos participantes abriu: o áudio e os pedidos podem ir à sessão. */
  live: boolean;
  statsTimer: ReturnType<typeof setInterval> | null;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Microfone desligado pelo usuário: nada do canal "me" vai ao Deepgram. */
  micMuted: boolean;
}

/** Rejeita após `ms`; uma captura que chegue depois do prazo é parada imediatamente. */
function captureWithTimeout(capture: Promise<ChannelCapture>, ms: number): Promise<ChannelCapture> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error("tempo esgotado"));
    }, ms);
    capture.then(
      (result) => {
        if (settled) {
          result.stop();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class SessionController {
  private running: Run | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  async start(params: StartParams): Promise<void> {
    if (this.running) return;
    const run: Run = {
      params,
      tab: null,
      mic: null,
      session: null,
      live: false,
      statsTimer: null,
      stopping: false,
      stopTimer: null,
      micMuted: false,
    };
    this.running = run;
    this.deps.store.dispatch({ type: "starting", suggestionsEnabled: params.openRouterKey !== "" });

    const callbacks: CaptureCallbacks = {
      onFrame: (channel, pcm) => {
        if (channel === "me" && run.micMuted) return;
        if (run.live && !run.stopping) run.session?.acceptPcm(channel, new Uint8Array(pcm));
      },
      onLevel: (channel, rms) => {
        if (channel === "me" && run.micMuted) return;
        if (this.running === run) this.deps.store.dispatch({ type: "level", channel, rms });
      },
      onEnded: (channel) => this.onCaptureEnded(run, channel),
    };

    let tab: ChannelCapture;
    try {
      tab = await this.deps.captureTab(params.streamId, callbacks);
    } catch (error) {
      if (this.running === run) this.fail(run, `Não foi possível capturar o áudio da aba: ${errorText(error)}`);
      return;
    }
    if (this.running !== run) {
      tab.stop();
      return;
    }
    run.tab = tab;

    let mic: ChannelCapture | null = null;
    try {
      mic = await captureWithTimeout(this.deps.captureMic(callbacks), MIC_CAPTURE_TIMEOUT_MS);
    } catch {
      mic = null;
    }
    if (this.running !== run) {
      mic?.stop();
      return;
    }
    run.mic = mic;
    this.deps.store.dispatch({ type: "mic", status: mic ? "active" : "denied" });

    const session = this.deps.createSession(params, (message) => this.onEngineMessage(run, message));
    run.session = session;
    try {
      await session.start();
    } catch (error) {
      // Parar durante a conexão também rejeita o start; aí a execução já foi liberada.
      if (this.running !== run) return;
      console.warn(`Deepgram não abriu: ${errorText(error)}`);
      this.fail(run, DEEPGRAM_UNAVAILABLE_MESSAGE);
      return;
    }
    if (this.running !== run) return;
    run.live = true;
    run.statsTimer = setInterval(() => {
      if (run.session) this.deps.store.dispatch({ type: "stats", stats: run.session.stats() });
    }, STATS_INTERVAL_MS);
  }

  /** Pede uma sugestão de resposta (para a pergunta escolhida, se houver); sem sessão rodando, não faz nada. */
  requestSuggestion(question?: SuggestionQuestion): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.session) return;
    const requestId = (this.deps.newRequestId ?? (() => crypto.randomUUID()))();
    run.session.requestSuggestion(requestId, question);
  }

  /** Liga ou desliga o envio do microfone; o microfone continua aberto para religar na hora. */
  setMicMuted(muted: boolean): void {
    const run = this.running;
    if (!run || run.stopping) return;
    run.micMuted = muted;
    this.deps.store.dispatch({ type: "mic-muted", muted });
  }

  /** Mudanças de modo, contexto, currículo ou vaga durante a sessão. */
  update(changes: SessionSettingsChanges): void {
    const run = this.running;
    if (!run?.live || run.stopping || !run.session) return;
    run.session.update(changes);
  }

  stop(): void {
    const run = this.running;
    if (!run || run.stopping) return;
    if (!run.live || !run.session) {
      // Ainda capturando ou conectando ao Deepgram: não há falas a finalizar.
      this.release(run, "stopped");
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
    // Para de capturar, mas deixa o Deepgram entregar as últimas falas antes de encerrar.
    run.stopping = true;
    const session = run.session;
    this.releaseCaptures(run);
    session.beginStop();
    this.deps.store.dispatch({ type: "stopping" });
    const deadline = new Promise<void>((resolve) => {
      run.stopTimer = setTimeout(resolve, STOP_TIMEOUT_MS);
    });
    void Promise.race([session.drain(), deadline]).then(() => {
      if (this.running !== run) return;
      this.release(run, "stopped");
      this.deps.store.dispatch({ type: "stopped" });
    });
  }

  private onEngineMessage(run: Run, message: EngineMessage): void {
    if (this.running !== run) return;
    this.deps.store.dispatch({ type: "engine", message });
    this.deps.onEngineMessage?.(message);
  }

  private onCaptureEnded(run: Run, channel: Channel): void {
    if (this.running !== run || run.stopping) return;
    if (channel === "them") {
      this.fail(run, TAB_CAPTURE_ENDED_MESSAGE);
      return;
    }
    run.mic?.stop();
    run.mic = null;
    this.deps.store.dispatch({ type: "mic", status: "denied" });
  }

  private fail(run: Run, message: string): void {
    this.release(run, "error");
    this.deps.store.dispatch({ type: "failed", message });
  }

  private releaseCaptures(run: Run): void {
    if (run.statsTimer) clearInterval(run.statsTimer);
    run.statsTimer = null;
    run.tab?.stop();
    run.tab = null;
    run.mic?.stop();
    run.mic = null;
  }

  private release(run: Run, reason: SessionEndReason): void {
    if (run.stopTimer) clearTimeout(run.stopTimer);
    run.stopTimer = null;
    run.live = false;
    this.releaseCaptures(run);
    const session = run.session;
    run.session = null;
    // Com a execução ainda ativa: o fim da sessão (e a sugestão cancelada) chegam ao store.
    session?.close(reason);
    if (this.running === run) this.running = null;
  }
}
```

- [ ] **Step 7: Teste do controlador reescrito**

`apps/extension/src/offscreen/session-controller.test.ts` (arquivo inteiro):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelStats } from "@snowspeak/engine";
import type { Channel, EngineMessage, SessionEndReason } from "@snowspeak/shared";
import {
  DEEPGRAM_UNAVAILABLE_MESSAGE,
  MIC_CAPTURE_TIMEOUT_MS,
  STATS_INTERVAL_MS,
  STOP_TIMEOUT_MS,
  TAB_CAPTURE_ENDED_MESSAGE,
  SessionController,
  type CaptureCallbacks,
  type ChannelCapture,
  type ControllerDeps,
  type EngineSession,
  type SessionSettingsChanges,
  type StartParams,
  type SuggestionQuestion,
} from "./session-controller";
import { SessionStore } from "./session-store";

class FakeSession implements EngineSession {
  readonly pcm: Array<[Channel, number]> = [];
  readonly updates: SessionSettingsChanges[] = [];
  readonly requests: Array<[string, SuggestionQuestion | undefined]> = [];
  stopping = false;
  closedWith: SessionEndReason | null = null;
  private opened = false;
  private settleStart: { resolve(): void; reject(error: Error): void } | null = null;
  private finishDrain: (() => void) | null = null;

  constructor(
    readonly params: StartParams,
    private readonly onMessage: (message: EngineMessage) => void,
  ) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settleStart = { resolve, reject };
    });
  }
  /** O Deepgram dos participantes abriu. */
  open(): void {
    this.opened = true;
    this.onMessage({ v: 1, type: "session.started", sessionId: "s1" });
    this.settleStart?.resolve();
  }
  /** O Deepgram recusou a primeira conexão (ou a sessão fechou antes de abrir). */
  refuse(): void {
    this.settleStart?.reject(new Error("Deepgram encerrou a conexão (código 1006)"));
  }
  emit(message: EngineMessage): void {
    this.onMessage(message);
  }
  acceptPcm(channel: Channel, pcm: Uint8Array): void {
    this.pcm.push([channel, pcm.byteLength]);
  }
  stats(): Record<Channel, ChannelStats> {
    return { them: { sentFrames: 3, droppedFrames: 1 }, me: { sentFrames: 2, droppedFrames: 0 } };
  }
  update(changes: SessionSettingsChanges): void {
    this.updates.push(changes);
  }
  requestSuggestion(requestId: string, question?: SuggestionQuestion): void {
    this.requests.push([requestId, question]);
  }
  beginStop(): void {
    this.stopping = true;
  }
  drain(): Promise<void> {
    return new Promise((resolve) => {
      this.finishDrain = resolve;
    });
  }
  drained(): void {
    this.finishDrain?.();
  }
  close(reason: SessionEndReason): void {
    if (this.closedWith) return;
    this.closedWith = reason;
    if (this.opened) this.onMessage({ v: 1, type: "session.ended", sessionId: "s1", reason });
  }
}

interface FakeCapture extends ChannelCapture {
  stopped: boolean;
}

function fakeCapture(): FakeCapture {
  const capture: FakeCapture = {
    stopped: false,
    stop() {
      capture.stopped = true;
    },
  };
  return capture;
}

const params: StartParams = {
  streamId: "stream-1",
  deepgramKey: "dg-key",
  openRouterKey: "or-key",
  suggestionModel: "anthropic/claude-haiku-4.5",
  mode: "work",
  context: "",
  profile: "Node dev",
  job: "Backend",
};

// Deixa as capturas (promessas já resolvidas) andarem até a criação da sessão; funciona com timers falsos.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface SetupOverrides {
  tab?: () => Promise<ChannelCapture>;
  mic?: () => Promise<ChannelCapture>;
}

function setup(overrides: SetupOverrides = {}) {
  const store = new SessionStore();
  const sessions: FakeSession[] = [];
  const tab = fakeCapture();
  const mic = fakeCapture();
  let callbacks: CaptureCallbacks | null = null;
  let requestIds = 0;
  const onEngineMessage = vi.fn((_message: EngineMessage): void => undefined);

  const deps: ControllerDeps = {
    store,
    captureTab: vi.fn((_streamId: string, cb: CaptureCallbacks) => {
      callbacks = cb;
      return overrides.tab ? overrides.tab() : Promise.resolve(tab);
    }),
    captureMic: vi.fn(() => (overrides.mic ? overrides.mic() : Promise.resolve(mic))),
    createSession: (sessionParams, onMessage) => {
      const session = new FakeSession(sessionParams, onMessage);
      sessions.push(session);
      return session;
    },
    onEngineMessage,
    newRequestId: () => `req-${++requestIds}`,
  };

  return {
    controller: new SessionController(deps),
    store,
    sessions,
    tab,
    mic,
    onEngineMessage,
    session(): FakeSession {
      const session = sessions.at(-1);
      if (!session) throw new Error("nenhuma sessão criada");
      return session;
    },
    emitFrame(channel: Channel) {
      callbacks?.onFrame(channel, new ArrayBuffer(3200));
    },
    emitLevel(channel: Channel, rms: number) {
      callbacks?.onLevel(channel, rms);
    },
    emitEnded(channel: Channel) {
      callbacks?.onEnded(channel);
    },
  };
}

async function startRunning(t: ReturnType<typeof setup>): Promise<FakeSession> {
  const starting = t.controller.start(params);
  await settle();
  t.session().open();
  await starting;
  return t.session();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionController", () => {
  it("cria a sessão com as chaves depois de capturar aba e microfone e fica rodando quando o Deepgram abre", async () => {
    const t = setup();
    const session = await startRunning(t);
    expect(session.params).toEqual(params);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "active", sessionId: "s1", suggestionsEnabled: true });
  });

  it("sem chave do OpenRouter, a sessão começa com as sugestões desligadas", async () => {
    const t = setup();
    const starting = t.controller.start({ ...params, openRouterKey: "" });
    expect(t.store.snapshot().suggestionsEnabled).toBe(false);
    await settle();
    t.session().open();
    await starting;
  });

  it("só entrega áudio depois que o Deepgram abriu", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.emitFrame("them");
    expect(t.session().pcm).toEqual([]);
    t.session().open();
    await starting;
    t.emitFrame("them");
    t.emitFrame("me");
    expect(t.session().pcm).toEqual([
      ["them", 3200],
      ["me", 3200],
    ]);
  });

  it("falha com a mensagem do Deepgram e libera as capturas quando a primeira conexão é recusada", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.session().refuse();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: DEEPGRAM_UNAVAILABLE_MESSAGE });
    expect(t.tab.stopped).toBe(true);
    expect(t.mic.stopped).toBe(true);
    expect(t.session().closedWith).toBe("error");
  });

  it("segue só com a aba quando o microfone é negado", async () => {
    const t = setup({ mic: () => Promise.reject(new Error("denied")) });
    await startRunning(t);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("segue sem microfone quando o pedido do microfone não responde", async () => {
    vi.useFakeTimers();
    const t = setup({ mic: () => new Promise<ChannelCapture>(() => undefined) });
    const starting = t.controller.start(params);
    await vi.advanceTimersByTimeAsync(MIC_CAPTURE_TIMEOUT_MS);
    t.session().open();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("falha sem criar sessão quando a captura da aba falha", async () => {
    const t = setup({ tab: () => Promise.reject(new Error("sem permissão")) });
    await t.controller.start(params);
    expect(t.sessions).toEqual([]);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "Não foi possível capturar o áudio da aba: sem permissão" });
  });

  it("ignora um segundo start enquanto o primeiro está em andamento", async () => {
    const t = setup();
    const first = t.controller.start(params);
    await t.controller.start(params);
    await settle();
    expect(t.sessions).toHaveLength(1);
    t.session().open();
    await first;
  });

  it("stop espera as últimas falas do Deepgram e depois encerra", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    expect(t.tab.stopped).toBe(true);
    expect(session.stopping).toBe(true);
    expect(t.store.snapshot().status).toBe("stopping");
    expect(session.closedWith).toBeNull();
    session.drained();
    await settle();
    expect(session.closedWith).toBe("stopped");
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("stop desiste de esperar depois do prazo de segurança", async () => {
    vi.useFakeTimers();
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    expect(session.closedWith).toBe("stopped");
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("stop antes de o Deepgram abrir libera tudo na hora", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.controller.stop();
    expect(t.store.snapshot().status).toBe("idle");
    expect(t.tab.stopped).toBe(true);
    expect(t.session().closedWith).toBe("stopped");
    // A sessão real rejeita o start pendente ao fechar; isso não pode virar erro na tela.
    t.session().refuse();
    await starting;
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
  });

  it("stop durante a captura da aba descarta a captura atrasada", async () => {
    let resolveTab: (capture: ChannelCapture) => void = () => undefined;
    const t = setup({
      tab: () =>
        new Promise<ChannelCapture>((resolve) => {
          resolveTab = resolve;
        }),
    });
    const starting = t.controller.start(params);
    t.controller.stop();
    resolveTab(t.tab);
    await starting;
    expect(t.tab.stopped).toBe(true);
    expect(t.sessions).toEqual([]);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("encerra a sessão quando a captura da aba termina", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.emitEnded("them");
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: TAB_CAPTURE_ENDED_MESSAGE });
    expect(session.closedWith).toBe("error");
    expect(t.mic.stopped).toBe(true);
  });

  it("ignora o fim da captura da aba enquanto finaliza", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.stop();
    t.emitEnded("them");
    expect(t.store.snapshot().status).toBe("stopping");
    session.drained();
    await settle();
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("segue só com a aba quando o microfone deixa de funcionar", async () => {
    const t = setup();
    await startRunning(t);
    t.emitEnded("me");
    expect(t.mic.stopped).toBe(true);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("aplica as mensagens do motor ao store e depois as repassa ao gancho", async () => {
    const t = setup();
    const session = await startRunning(t);
    const partial: EngineMessage = { v: 1, type: "transcript.partial", sessionId: "s1", seq: 1, ts: 0, channel: "them", utteranceId: "them-1", text: "hi" };
    t.onEngineMessage.mockImplementation((): void => {
      expect(t.store.snapshot().captions[0]?.partial).toBe("hi");
    });
    session.emit(partial);
    expect(t.onEngineMessage).toHaveBeenLastCalledWith(partial);
  });

  it("publica estatísticas de frames periodicamente", async () => {
    vi.useFakeTimers();
    const t = setup();
    await startRunning(t);
    vi.advanceTimersByTime(STATS_INTERVAL_MS);
    expect(t.store.snapshot().channels.them).toMatchObject({ sentFrames: 3, droppedFrames: 1 });
  });

  it("pede sugestão com um requestId novo, com ou sem pergunta escolhida", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.requestSuggestion();
    t.controller.requestSuggestion({ utteranceId: "them-3", text: "Why us?" });
    expect(session.requests).toEqual([
      ["req-1", undefined],
      ["req-2", { utteranceId: "them-3", text: "Why us?" }],
    ]);
  });

  it("não pede sugestão nem repassa mudanças antes de o Deepgram abrir", async () => {
    const t = setup();
    const starting = t.controller.start(params);
    await settle();
    t.controller.requestSuggestion();
    t.controller.update({ mode: "interview" });
    expect(t.session().requests).toEqual([]);
    expect(t.session().updates).toEqual([]);
    t.session().open();
    await starting;
  });

  it("repassa mudanças de contexto durante a sessão", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.update({ profile: "Kafka" });
    expect(session.updates).toEqual([{ profile: "Kafka" }]);
  });
});

describe("microfone desligado", () => {
  it("não entrega o áudio do microfone enquanto desligado e volta a entregar ao religar", async () => {
    const t = setup();
    const session = await startRunning(t);
    t.controller.setMicMuted(true);
    t.emitFrame("me");
    t.emitFrame("them");
    expect(session.pcm).toEqual([["them", 3200]]);
    expect(t.store.snapshot().micMuted).toBe(true);
    t.controller.setMicMuted(false);
    t.emitFrame("me");
    expect(session.pcm).toEqual([
      ["them", 3200],
      ["me", 3200],
    ]);
  });

  it("zera o nível do microfone e ignora o nível enquanto desligado", async () => {
    const t = setup();
    await startRunning(t);
    t.emitLevel("me", 0.5);
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().channels.me.level).toBe(0);
    t.emitLevel("me", 0.7);
    expect(t.store.snapshot().channels.me.level).toBe(0);
  });

  it("sem sessão, não faz nada; nova sessão começa com o microfone ligado", async () => {
    const t = setup();
    t.controller.setMicMuted(true);
    expect(t.store.snapshot().micMuted).toBe(false);
    const first = await startRunning(t);
    t.controller.setMicMuted(true);
    t.controller.stop();
    first.drained();
    await settle();
    const second = await startRunning(t);
    t.emitFrame("me");
    expect(second.pcm).toEqual([["me", 3200]]);
    expect(t.store.snapshot().micMuted).toBe(false);
  });
});
```

- [ ] **Step 8: Offscreen, fila de tradução, mensagens e painel**

`apps/extension/src/offscreen/main.ts` (arquivo inteiro):

```ts
import { DEFAULT_SUGGESTION_MODEL, LocalSession, createDeepgramSttFactory, createOpenRouterSuggester } from "@snowspeak/engine";
import type { RuntimeMessage } from "../messaging";
import { createChromeTranslator } from "../translation/chrome-translator";
import { captureMic, captureTab } from "./capture";
import { BROADCAST_INTERVAL_MS, createCoalescer } from "./coalesce";
import { handleOffscreenMessage } from "./message-handler";
import { SessionController } from "./session-controller";
import { SessionStore } from "./session-store";
import { TranslationQueue } from "./translation-queue";

const store = new SessionStore();
const translations = new TranslationQueue(createChromeTranslator, store);
const controller = new SessionController({
  store,
  captureTab,
  captureMic,
  // As chaves chegam do painel a cada Iniciar e vivem só nesta sessão.
  createSession: (params, onMessage) =>
    new LocalSession(
      {
        sttFactory: createDeepgramSttFactory({ apiKey: params.deepgramKey }),
        suggester: params.openRouterKey
          ? createOpenRouterSuggester({ apiKey: params.openRouterKey, model: params.suggestionModel || DEFAULT_SUGGESTION_MODEL })
          : null,
        onMessage,
      },
      { mode: params.mode, context: params.context, profile: params.profile, job: params.job },
    ),
  onEngineMessage: (message) => translations.handle(message),
});

const broadcast = createCoalescer(() => {
  const message: RuntimeMessage = { target: "sidepanel", type: "state", state: store.snapshot() };
  // O painel pode estar fechado; nesse caso não há receptor.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}, BROADCAST_INTERVAL_MS);
store.subscribe(broadcast);

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  const response = handleOffscreenMessage(message, controller, store);
  if (response !== undefined) sendResponse(response);
});
```

Em `translation-queue.ts`, o `perl` do Step 3 já trocou `ServerMessage` por `EngineMessage`. Troque também o comentário "Traduz cada frase que o servidor marca como pronta" por "Traduz cada frase que o motor marca como pronta".

Em `apps/extension/src/offscreen/message-handler.test.ts`, troque a constante `params` por:

```ts
const params: StartParams = {
  streamId: "s",
  deepgramKey: "dg",
  openRouterKey: "",
  suggestionModel: "anthropic/claude-haiku-4.5",
  mode: "work",
  context: "",
  profile: "",
  job: "",
};
```

`apps/extension/src/sidepanel/panel-view.ts`, em `isCaptureMode`:

```ts
  return pendingStart || status === "starting" || status === "running" || status === "stopping";
```

Em `panel-view.test.ts`, apague a linha `expect(isCaptureMode("reconnecting", false)).toBe(true);`.

`apps/extension/sidepanel.html`: troque as duas linhas de "Servidor" e "Chave de acesso" por:

```html
      <label>Chave do Deepgram <input id="deepgramKey" type="password" autocomplete="off" spellcheck="false" /></label>
      <label>Chave do OpenRouter (opcional) <input id="openRouterKey" type="password" autocomplete="off" spellcheck="false" /></label>
      <label>Modelo das sugestões <input id="suggestionModel" type="text" autocomplete="off" spellcheck="false" /></label>
```

`apps/extension/src/sidepanel/main.ts`:

1. Imports: acrescente `import { DEFAULT_SUGGESTION_MODEL } from "@snowspeak/engine";`.
2. `DEFAULT_SETTINGS`:

```ts
const DEFAULT_SETTINGS: PanelStartParams = {
  deepgramKey: "",
  openRouterKey: "",
  suggestionModel: DEFAULT_SUGGESTION_MODEL,
  mode: "work",
  context: "",
  profile: "",
  job: "",
};
// Campos da versão com servidor, apagados do storage na primeira abertura.
const LEGACY_SETTINGS = ["serverUrl", "token"];
```

3. Remova `reconnecting: "Reconectando…",` de `STATUS_LABELS`.
4. Troque `serverUrlInput` e `tokenInput` por:

```ts
const deepgramKeyInput = byId<HTMLInputElement>("deepgramKey");
const openRouterKeyInput = byId<HTMLInputElement>("openRouterKey");
const suggestionModelInput = byId<HTMLInputElement>("suggestionModel");
```

5. Em `render()`:

```ts
  const active = pendingStart || state.status === "starting" || state.status === "running";
```

e

```ts
  muteMicButton.disabled = state.mic !== "active" || state.status !== "running";
```

6. Apague a função `isWebSocketUrl`.
7. `readForm()`:

```ts
function readForm(): PanelStartParams {
  const mode = MODES.includes(modeSelect.value as Mode) ? (modeSelect.value as Mode) : "work";
  return {
    // Chaves coladas costumam vir com espaço ou quebra de linha.
    deepgramKey: deepgramKeyInput.value.trim(),
    openRouterKey: openRouterKeyInput.value.trim(),
    suggestionModel: suggestionModelInput.value.trim() || DEFAULT_SUGGESTION_MODEL,
    mode,
    context: contextInput.value,
    profile: profileInput.value,
    job: jobInput.value,
  };
}
```

8. `loadSettings()`:

```ts
async function loadSettings(): Promise<void> {
  await chrome.storage.local.remove(LEGACY_SETTINGS);
  const settings = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as PanelStartParams;
  deepgramKeyInput.value = settings.deepgramKey;
  openRouterKeyInput.value = settings.openRouterKey;
  suggestionModelInput.value = settings.suggestionModel;
  modeSelect.value = settings.mode;
  contextInput.value = settings.context;
  profileInput.value = settings.profile;
  jobInput.value = settings.job;
  render();
}
```

9. No clique de Iniciar, troque as duas validações (endereço e chave de acesso) por:

```ts
  if (!settings.deepgramKey) {
    showLocalError("Informe a chave do Deepgram em Configurações.");
    settingsPanel.open = true;
    return;
  }
```

10. Salve as chaves quando o usuário edita: na linha `for (const field of [modeSelect, contextInput, profileInput, jobInput]) field.addEventListener("change", onSettingsChanged);`, acrescente `deepgramKeyInput, openRouterKeyInput, suggestionModelInput` à lista. O `onSettingsChanged` já grava `readForm()` inteiro e só repassa ao offscreen os campos de sugestão.

`apps/extension/public/manifest.json`: depois de `"permissions": [...]`, acrescente:

```json
  "host_permissions": ["https://api.deepgram.com/*", "https://openrouter.ai/*"],
```

- [ ] **Step 9: Rodar tudo e procurar sobras do protocolo antigo**

```bash
pnpm install
pnpm test
pnpm typecheck
grep -rnE "resumeToken|reconnecting\"|CLOSE_CODES|serverUrl|parseServerMessage|ClientMessage|encodeFrame|zod" packages apps/extension/src apps/extension/*.html
pnpm --filter @snowspeak/extension build
```

Expected: testes, typecheck e build verdes. O `grep` pode achar só `LEGACY_SETTINGS` (`serverUrl`) em `sidepanel/main.ts` e o `"reconnecting"` de `stt.status`; qualquer outra ocorrência é sobra a remover.

- [ ] **Step 10: Commit**

```bash
git add -A packages apps/extension pnpm-lock.yaml
git commit -m "feat(extension): sessão roda no offscreen com as chaves do usuário

O controlador chama o LocalSession direto; saem o socket, a retomada
de sessão, o heartbeat e a codificação binária dos frames. O painel
troca Servidor e Chave de acesso pelas chaves do Deepgram e do
OpenRouter e pelo modelo das sugestões; o manifesto libera só
api.deepgram.com e openrouter.ai.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Testar chaves e sugestões desligadas no painel

**Files:**
- Create: `apps/extension/src/sidepanel/key-check.ts`
- Test: `apps/extension/src/sidepanel/key-check.test.ts`
- Modify: `apps/extension/src/sidepanel/suggestion-view.ts`, `suggestion-view.test.ts`
- Modify: `apps/extension/src/sidepanel/main.ts`, `apps/extension/sidepanel.html`

**Interfaces:**
- Produces: `type KeyCheck = "ok" | "rejected" | "missing" | "failed"`, `checkDeepgramKey(key: string, fetchImpl?: KeyFetch): Promise<KeyCheck>`, `checkOpenRouterKey(...)`, `describeKeyCheck(provider: "Deepgram" | "OpenRouter", result: KeyCheck): string`, `DEEPGRAM_CHECK_URL`, `OPENROUTER_CHECK_URL`; `suggestionCard(suggestion, notice, suggestionsEnabled = true)`, `SUGGESTIONS_DISABLED_NOTICE`.

- [ ] **Step 1: Testes que falham**

`apps/extension/src/sidepanel/key-check.test.ts`:

```ts
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
```

Em `suggestion-view.test.ts`, troque o import por `import { SUGGESTIONS_DISABLED_NOTICE, suggestionCard } from "./suggestion-view";` e acrescente no `describe`:

```ts
  it("avisa que as sugestões estão desligadas sem a chave do OpenRouter", () => {
    expect(suggestionCard(null, null, false)).toMatchObject({ visible: true, label: "", en: "", notice: SUGGESTIONS_DISABLED_NOTICE });
    expect(SUGGESTIONS_DISABLED_NOTICE).toBe("Sugestões desligadas: informe a chave do OpenRouter.");
  });
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `pnpm vitest run apps/extension/src/sidepanel`
Expected: FAIL (`./key-check` não existe; `SUGGESTIONS_DISABLED_NOTICE` não existe).

- [ ] **Step 3: Implementar**

`apps/extension/src/sidepanel/key-check.ts`:

```ts
export type KeyCheck = "ok" | "rejected" | "missing" | "failed";

export const DEEPGRAM_CHECK_URL = "https://api.deepgram.com/v1/projects";
export const OPENROUTER_CHECK_URL = "https://openrouter.ai/api/v1/key";

export type KeyFetch = (url: string, init: RequestInit) => Promise<{ status: number }>;

const browserFetch: KeyFetch = (url, init) => fetch(url, init);

async function check(url: string, authorization: (key: string) => string, rawKey: string, fetchImpl: KeyFetch): Promise<KeyCheck> {
  const key = rawKey.trim();
  if (!key) return "missing";
  try {
    const { status } = await fetchImpl(url, { headers: { Authorization: authorization(key) } });
    if (status >= 200 && status < 300) return "ok";
    if (status === 401 || status === 403) return "rejected";
    return "failed";
  } catch {
    return "failed";
  }
}

/** Uma chamada leve e gratuita que só responde 200 com uma chave válida. */
export function checkDeepgramKey(key: string, fetchImpl: KeyFetch = browserFetch): Promise<KeyCheck> {
  return check(DEEPGRAM_CHECK_URL, (k) => `Token ${k}`, key, fetchImpl);
}

export function checkOpenRouterKey(key: string, fetchImpl: KeyFetch = browserFetch): Promise<KeyCheck> {
  return check(OPENROUTER_CHECK_URL, (k) => `Bearer ${k}`, key, fetchImpl);
}

export function describeKeyCheck(provider: "Deepgram" | "OpenRouter", result: KeyCheck): string {
  switch (result) {
    case "ok":
      return `${provider}: ok`;
    case "rejected":
      return `${provider}: chave recusada`;
    case "missing":
      return provider === "Deepgram" ? "Deepgram: informe a chave (obrigatória)" : "OpenRouter: não configurada (sem sugestões)";
    case "failed":
      return `${provider}: não foi possível testar agora (rede ou serviço fora do ar)`;
  }
}
```

`apps/extension/src/sidepanel/suggestion-view.ts`: depois de `ERROR_MESSAGES`:

```ts
export const SUGGESTIONS_DISABLED_NOTICE = "Sugestões desligadas: informe a chave do OpenRouter.";
```

e a função passa a ser:

```ts
export function suggestionCard(suggestion: SuggestionState | null, notice: string | null, suggestionsEnabled = true): SuggestionCard {
  if (!suggestionsEnabled) return { visible: true, label: "", en: "", pt: "", pending: false, error: null, notice: SUGGESTIONS_DISABLED_NOTICE };
  if (!suggestion) return { visible: notice !== null, label: "", en: "", pt: "", pending: false, error: null, notice };
```

(o restante da função não muda).

`apps/extension/sidepanel.html`, na seção Configurações, troque as três linhas das chaves (Tarefa 6) por:

```html
      <label>Chave do Deepgram <input id="deepgramKey" type="password" autocomplete="off" spellcheck="false" /></label>
      <p class="hint">Obrigatória. Gere em <a href="https://console.deepgram.com/" target="_blank" rel="noopener">console.deepgram.com</a> → API Keys.</p>
      <label>Chave do OpenRouter (opcional) <input id="openRouterKey" type="password" autocomplete="off" spellcheck="false" /></label>
      <p class="hint">Sem ela, a legenda funciona, mas não há sugestões de resposta. Gere em <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>.</p>
      <label>Modelo das sugestões <input id="suggestionModel" type="text" autocomplete="off" spellcheck="false" /></label>
      <p class="key-check"><button id="check-keys" type="button">Testar chaves</button> <span id="key-check-result" class="hint" aria-live="polite"></span></p>
```

e troque o parágrafo de privacidade (`<p class="hint">Currículo e vaga ficam salvos só neste navegador; …</p>`) por:

```html
      <p class="hint">Suas chaves, currículo e vaga ficam só neste navegador. O áudio vai direto ao Deepgram; a conversa, o currículo e a vaga vão direto ao OpenRouter apenas para gerar sugestões.</p>
```

`apps/extension/src/sidepanel/main.ts`:

1. Imports: `import { checkDeepgramKey, checkOpenRouterKey, describeKeyCheck } from "./key-check";`
2. Elementos:

```ts
const checkKeysButton = byId<HTMLButtonElement>("check-keys");
const keyCheckResult = byId<HTMLSpanElement>("key-check-result");
```

3. Em `fillCaptionItem`, a linha `const selectable = selectableQuestion(caption) !== null;` passa a ser:

```ts
  const selectable = selectableQuestion(caption) !== null && lastState.suggestionsEnabled;
```

4. Em `renderSuggestion`:

```ts
  const card = suggestionCard(state.suggestion, state.suggestionNotice, state.suggestionsEnabled);
```

e

```ts
  suggestButton.disabled = state.status !== "running" || !state.suggestionsEnabled;
```

5. Em `requestSuggestionFor`, a primeira linha passa a ser:

```ts
  if (lastState.status !== "running" || !lastState.suggestionsEnabled || !(target instanceof Element)) return;
```

6. Depois do listener de `skipTranslatorButton`:

```ts
checkKeysButton.addEventListener("click", async () => {
  const { deepgramKey, openRouterKey } = readForm();
  checkKeysButton.disabled = true;
  keyCheckResult.textContent = "Testando…";
  const [deepgram, openRouter] = await Promise.all([checkDeepgramKey(deepgramKey), checkOpenRouterKey(openRouterKey)]);
  keyCheckResult.textContent = `${describeKeyCheck("Deepgram", deepgram)} · ${describeKeyCheck("OpenRouter", openRouter)}`;
  checkKeysButton.disabled = false;
});
```

- [ ] **Step 4: Rodar e ver passar**

```bash
pnpm test
pnpm typecheck
pnpm --filter @snowspeak/extension build
```

Expected: PASS e build sem erros.

- [ ] **Step 5: Commit**

```bash
git add -A apps/extension
git commit -m "feat(extension): botão Testar chaves e sugestões desligadas sem OpenRouter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: README e validação no Chrome

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Reescrever o topo do README**

Troque tudo desde a primeira linha até antes de `## Marco 1 — roteiro de validação` por:

````markdown
# SnowSpeak

Legendas EN→PT-BR em tempo real e sugestões de resposta para chamadas no navegador. A extensão funciona sozinha, com as chaves do próprio usuário: a transcrição usa o Deepgram, as sugestões usam o OpenRouter e a tradução roda no próprio Chrome.

- Spec atual: `docs/superpowers/specs/2026-09-27-byok-so-extensao-design.md`
- Specs e planos anteriores: `docs/superpowers/` (a versão com servidor está no histórico do git até o commit `0706794`)

## Requisitos

- Node 20+
- pnpm 9 (`corepack prepare pnpm@9.15.9 --activate`)
- Google Chrome 116+ (a tradução precisa do Chrome 138+ para desktop)
- Uma chave do Deepgram (console.deepgram.com → API Keys; a conta nova vem com crédito)
- Opcional: uma chave do OpenRouter para as sugestões (openrouter.ai → Keys)

## Desenvolvimento

```bash
pnpm install
pnpm test
pnpm --filter @snowspeak/extension build
```

1. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha `apps/extension/dist`.
2. Na aba que você quer capturar, clique no ícone do SnowSpeak. O painel abre associado **a essa aba**.
3. Em **Configurações**, cole a chave do Deepgram (e, se quiser sugestões, a do OpenRouter) e clique em **Testar chaves**.
4. Clique em **Iniciar**.

Depois de mudar o código: `pnpm --filter @snowspeak/extension build` e clique em recarregar no card da extensão.

### O que o painel mostra

A legenda da conversa. O inglês aparece enquanto a pessoa fala (em cinza enquanto é provisório), o português aparece em verde abaixo de cada frase dos participantes, e as suas falas aparecem em roxo, sem tradução. Na primeira sessão, o Chrome pode baixar o modelo de tradução (há um botão para seguir só em inglês enquanto isso). Com a chave do OpenRouter, a sugestão de resposta aparece logo abaixo da pergunta.

## BYOK — roteiro de validação

- [ ] Em `chrome://extensions` → Detalhes do SnowSpeak → Acesso ao site, aparecem só `api.deepgram.com` e `openrouter.ai`.
- [ ] Iniciar sem a chave do Deepgram: "Informe a chave do Deepgram em Configurações." e nada é capturado.
- [ ] **Testar chaves** com as duas chaves certas: "Deepgram: ok · OpenRouter: ok".
- [ ] **Testar chaves** com uma chave errada em cada campo: "chave recusada" no provedor certo.
- [ ] **Testar chaves** sem a chave do OpenRouter: "OpenRouter: não configurada (sem sugestões)".
- [ ] Iniciar com a chave do Deepgram errada: "Não foi possível conectar ao Deepgram. Confira a chave em Configurações." e a captura é liberada.
- [ ] Sessão com as duas chaves num vídeo de entrevista em inglês: legenda, tradução e sugestão automática como nos marcos 3 a 5.
- [ ] Sessão sem a chave do OpenRouter: legenda e tradução funcionam; o cartão mostra "Sugestões desligadas: informe a chave do OpenRouter." e o botão de sugerir fica desabilitado.
- [ ] Chave do OpenRouter errada numa sessão: o cartão mostra "O OpenRouter recusou a chave. Confira em Configurações."
- [ ] Desligar o Wi-Fi por ~10 s no meio da sessão: aparece "Reconectando ao Deepgram…", a fala em andamento fica como interrompida, e ao religar o aviso some e a legenda volta.
- [ ] Desligar o Wi-Fi por mais de 60 s: aparece "A transcrição dos participantes parou: não foi possível reconectar ao Deepgram." e a sessão continua até o Parar.
- [ ] Parar no meio de uma frase: "Finalizando…", as últimas palavras aparecem, depois "Parado".
- [ ] Fechar e reabrir o painel mantém a legenda e o aviso de reconexão.
- [ ] Nenhuma chave aparece no console do offscreen (`chrome://extensions` → Inspecionar visualizações → offscreen.html) nem em URLs na aba Rede.
- [ ] Repetir numa chamada real do Google Meet.

## Roteiros anteriores (versão com servidor)

Os roteiros abaixo foram validados na versão com servidor e ficam como histórico.
````

Nos roteiros antigos, rebaixe os títulos `## Marco …` para `### Marco …`, para que fiquem dentro de "Roteiros anteriores".

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README da versão só-extensão e roteiro de validação BYOK

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 3: Validação no Chrome (usuário)**

Rode `pnpm --filter @snowspeak/extension build`. Peça ao usuário para recarregar a extensão e seguir o roteiro "BYOK — roteiro de validação". Pergunte quais grupos ele de fato testou antes de marcar os itens no README. Corrija o que falhar (cada correção com teste e commit próprio) antes de seguir para a Tarefa 9.

---

### Task 9: Pacote para a Chrome Web Store

**Files:**
- Create: `apps/extension/icons-src/icon.svg`, `apps/extension/public/icons/icon-{16,32,48,128}.png`
- Create: `apps/extension/scripts/package.py`
- Create: `docs/loja/politica-de-privacidade.md`, `docs/loja/listagem.md`
- Modify: `apps/extension/public/manifest.json`, `apps/extension/package.json`, `.gitignore`, `README.md`

- [ ] **Step 1: Ícone**

`apps/extension/icons-src/icon.svg`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#1d4ed8"/>
  <path d="M28 38a14 14 0 0 1 14-14h44a14 14 0 0 1 14 14v34a14 14 0 0 1-14 14H58l-18 16v-16h2a14 14 0 0 1-14-14z" fill="#fff"/>
  <path d="M64 36v38M47.5 45.5l33 19M47.5 64.5l33-19" stroke="#1d4ed8" stroke-width="5" stroke-linecap="round"/>
</svg>
```

```bash
mkdir -p apps/extension/public/icons
for size in 16 32 48 128; do
  magick -density 384 -background none apps/extension/icons-src/icon.svg -resize ${size}x${size} apps/extension/public/icons/icon-${size}.png
done
file apps/extension/public/icons/*.png
```

Expected: quatro PNG com as dimensões certas. Abra o de 128 px (Read tool) e confira que o balão e o floco aparecem.

- [ ] **Step 2: Manifesto final**

`apps/extension/public/manifest.json` (arquivo inteiro):

```json
{
  "manifest_version": 3,
  "name": "SnowSpeak",
  "version": "0.2.0",
  "description": "Legendas em português e sugestões de resposta para chamadas em inglês, com as suas chaves do Deepgram e do OpenRouter.",
  "minimum_chrome_version": "116",
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "permissions": [
    "tabCapture",
    "offscreen",
    "sidePanel",
    "activeTab",
    "storage"
  ],
  "host_permissions": ["https://api.deepgram.com/*", "https://openrouter.ai/*"],
  "background": {
    "service_worker": "service-worker.js",
    "type": "module"
  },
  "side_panel": {
    "default_path": "sidepanel.html"
  },
  "action": {
    "default_title": "SnowSpeak",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png"
    }
  },
  "commands": {
    "suggest": {
      "suggested_key": {
        "default": "Alt+S"
      },
      "description": "Sugerir resposta"
    }
  }
}
```

Em `apps/extension/package.json`, troque `"version": "0.1.0"` por `"version": "0.2.0"`.

- [ ] **Step 3: Script do zip**

`apps/extension/scripts/package.py`:

```python
"""Gera o .zip da extensão para a Chrome Web Store a partir de dist/ (rode depois do build)."""
import json
import pathlib
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
dist = root / "dist"
version = json.loads((dist / "manifest.json").read_text(encoding="utf-8"))["version"]
out = root / f"snowspeak-{version}.zip"

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
    # O manifest.json precisa ficar na raiz do zip.
    for path in sorted(dist.rglob("*")):
        if path.is_file():
            archive.write(path, path.relative_to(dist).as_posix())

print(out)
```

Em `apps/extension/package.json`, `scripts`:

```json
    "build": "vite build",
    "package": "vite build && python3 scripts/package.py",
```

No `.gitignore` da raiz, acrescente:

```
apps/extension/*.zip
```

```bash
pnpm --filter @snowspeak/extension package
python3 -m zipfile -l apps/extension/snowspeak-0.2.0.zip | head -20
```

Expected: `manifest.json`, `icons/icon-128.png`, `service-worker.js`, `sidepanel.html` e `offscreen.html` na raiz do zip, sem `icons-src/`.

- [ ] **Step 4: Política de privacidade**

`docs/loja/politica-de-privacidade.md`:

```markdown
# Política de privacidade do SnowSpeak

Última atualização: 27 de setembro de 2026

## Português

O SnowSpeak é uma extensão do Chrome que mostra legendas em português e sugestões de resposta durante chamadas em inglês. Ela funciona com as chaves de API do próprio usuário e não tem servidor próprio: o desenvolvedor não recebe, não armazena e não vê nenhum dado.

**O que fica no seu navegador.** As chaves do Deepgram e do OpenRouter, o modelo escolhido, o modo, o contexto, o currículo, a descrição da vaga e as preferências do painel ficam em `chrome.storage.local`, só neste navegador. Eles não são sincronizados com a sua conta Google. A legenda da sessão fica na memória da extensão e some quando o Chrome fecha a extensão.

**O que sai do seu navegador, e para onde.** Só depois de você clicar em Iniciar numa aba:
- o áudio da aba e, se você permitir, do microfone vai direto ao **Deepgram** (api.deepgram.com), com a sua chave, para ser transcrito;
- se você informou a chave do OpenRouter, a transcrição recente, o modo, o contexto, o currículo e a descrição da vaga vão direto ao **OpenRouter** (openrouter.ai), com a sua chave, para gerar a sugestão de resposta. O OpenRouter repassa o pedido ao provedor do modelo escolhido.

A tradução roda no próprio Chrome (Translator API) e não envia nada. O botão Testar chaves faz uma consulta ao Deepgram e ao OpenRouter só para verificar se a chave é aceita.

O uso desses dados pelo Deepgram e pelo OpenRouter segue as políticas deles: https://deepgram.com/privacy e https://openrouter.ai/privacy.

**O que o SnowSpeak não faz.** Não vende dados, não usa dados para publicidade, não coleta estatísticas de uso e não envia nada a outros destinos além dos dois citados.

**Como apagar.** Apague as chaves e os textos nas Configurações do painel ou remova a extensão; o Chrome apaga o `chrome.storage.local` junto com ela.

**Contato:** mpneves1974@gmail.com

## English

SnowSpeak is a Chrome extension that shows Portuguese captions and reply suggestions during calls in English. It runs on the user's own API keys and has no server of its own: the developer does not receive, store or see any data.

**What stays in your browser.** Your Deepgram and OpenRouter keys, chosen model, mode, context, résumé, job description and panel preferences are kept in `chrome.storage.local`, in this browser only, and are not synced to your Google account. Session captions live in the extension's memory and are discarded when Chrome closes the extension.

**What leaves your browser, and where it goes.** Only after you click Start on a tab:
- the tab audio and, if you allow it, your microphone audio go directly to **Deepgram** (api.deepgram.com), with your key, for transcription;
- if you entered an OpenRouter key, the recent transcript, mode, context, résumé and job description go directly to **OpenRouter** (openrouter.ai), with your key, to generate the reply suggestion. OpenRouter forwards the request to the provider of the chosen model.

Translation runs inside Chrome (Translator API) and sends nothing. The Test keys button calls Deepgram and OpenRouter only to check whether each key is accepted.

Deepgram's and OpenRouter's handling of this data follows their policies: https://deepgram.com/privacy and https://openrouter.ai/privacy.

**What SnowSpeak does not do.** It does not sell data, use it for advertising, collect usage analytics, or send anything anywhere other than the two services above.

**How to delete.** Clear the keys and texts in the panel's Settings or remove the extension; Chrome deletes its `chrome.storage.local` with it.

**Contact:** mpneves1974@gmail.com
```

Antes do commit, pergunte ao usuário se o e-mail de contato pode ficar público nessa política ou qual endereço usar.

- [ ] **Step 5: Textos da loja**

`docs/loja/listagem.md`:

```markdown
# Chrome Web Store — listagem do SnowSpeak

## Nome
SnowSpeak

## Resumo (até 132 caracteres)
Legendas em português e sugestões de resposta em chamadas em inglês, com as suas chaves do Deepgram e do OpenRouter.

## Categoria
Produtividade (Ferramentas)

## Idioma
Português (Brasil)

## Descrição
O SnowSpeak ajuda quem participa de reuniões e entrevistas em inglês.

- Legenda ao vivo: o que os participantes dizem aparece em inglês e, logo abaixo de cada frase, em português.
- Suas falas aparecem ao lado, para você acompanhar a conversa inteira.
- Sugestões de resposta: quando alguém faz uma pergunta, o SnowSpeak sugere uma resposta curta em inglês, com a tradução, usando o seu currículo e a descrição da vaga (modo Entrevista) ou o contexto que você informar. Você também pode clicar numa pergunta ou apertar Alt+S para pedir a sugestão.
- Funciona em qualquer aba do Chrome: Google Meet, Zoom e Teams no navegador, vídeos.

Como funciona: o SnowSpeak usa as suas próprias chaves de API. A transcrição é feita pelo Deepgram (chave obrigatória; a conta nova vem com crédito) e as sugestões pelo OpenRouter (chave opcional). A tradução roda no próprio Chrome. Não há servidor do SnowSpeak no meio: o áudio e o texto vão direto do seu navegador para esses serviços, e as chaves ficam só no seu Chrome.

Requisitos: Chrome 138 ou mais novo no computador para a tradução.

## Finalidade única
Transcrever e traduzir o áudio de uma aba em chamada e sugerir respostas, num painel lateral.

## Justificativa das permissões
- tabCapture: capturar o áudio da aba da chamada, só depois que o usuário clica no ícone e em Iniciar.
- offscreen: documento que processa o áudio e mantém a conexão com o Deepgram durante a sessão, mesmo com o painel fechado.
- sidePanel: mostrar a legenda e as sugestões ao lado da página.
- activeTab: o clique no ícone autoriza a captura daquela aba.
- storage: guardar no próprio navegador as chaves, o currículo, a vaga e as preferências.
- Host api.deepgram.com: transcrição e teste da chave do Deepgram.
- Host openrouter.ai: sugestões de resposta e teste da chave do OpenRouter.
- Código remoto: não usa.

## Práticas de dados (formulário da loja)
Sugestão de respostas, a conferir pelo usuário no formulário:
- Dados tratados: comunicações pessoais (áudio e transcrição das chamadas) e informações pessoais que o usuário escolher colar (currículo, descrição da vaga).
- Esses dados vão só aos serviços que o usuário configurou (Deepgram e OpenRouter), com as chaves dele, para a função principal da extensão.
- Certificações: não vende dados a terceiros; não usa nem transfere dados para fins não relacionados à finalidade única; não usa dados para avaliar crédito ou conceder empréstimos.
- URL da política de privacidade: publicar `docs/loja/politica-de-privacidade.md` num endereço público (ex.: GitHub Pages ou Gist público) e colar a URL aqui.

## Capturas de tela (1280×800)
1. Painel durante uma entrevista em inglês: coluna do entrevistador com as frases traduzidas e a sugestão de resposta abaixo da pergunta.
2. Configurações preenchidas, depois de "Testar chaves" mostrar "Deepgram: ok · OpenRouter: ok" (com as chaves mascaradas).
3. Modo "Só português" durante uma reunião.
```

Confira o tamanho do resumo:

```bash
python3 -c "print(len('Legendas em português e sugestões de resposta em chamadas em inglês, com as suas chaves do Deepgram e do OpenRouter.'))"
```

Expected: no máximo 132.

- [ ] **Step 6: Seção de publicação no README**

No README, logo antes de `## Roteiros anteriores (versão com servidor)`, acrescente:

````markdown
## Publicação na Chrome Web Store

```bash
pnpm --filter @snowspeak/extension package
```

Gera `apps/extension/snowspeak-<versão>.zip`. Para enviar:

1. Publique `docs/loja/politica-de-privacidade.md` num endereço público e guarde a URL.
2. Na conta de desenvolvedor da Chrome Web Store, crie o item e envie o zip.
3. Preencha a listagem, as permissões e as práticas de dados com `docs/loja/listagem.md`, e envie as capturas de tela listadas lá.
4. A cada versão nova, aumente `version` em `apps/extension/public/manifest.json` e `apps/extension/package.json` e gere o zip de novo.

- [ ] Carregar o conteúdo do zip descompactado (Carregar sem compactação) e repetir os itens principais do roteiro BYOK: ícone na barra, Testar chaves, uma sessão com legenda e sugestão.
````

- [ ] **Step 7: Rodar tudo e commit**

```bash
pnpm test
pnpm typecheck
pnpm --filter @snowspeak/extension package
git add -A apps/extension docs/loja .gitignore README.md
git commit -m "feat(loja): ícones, manifesto 0.2.0, política de privacidade, listagem e zip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Validação final (usuário)**

Peça ao usuário para carregar o zip descompactado e seguir o item da seção "Publicação na Chrome Web Store". Depois da validação, com a autorização dele: merge `--no-ff` de `feat/byok` na `master` e push para o GitHub.
