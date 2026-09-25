# Marco 5 — Sugestão de resposta (OpenRouter) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar no painel uma sugestão de resposta em inglês, com a tradução em português abaixo, gerada automaticamente quando o participante faz uma pergunta e também a pedido (botão ou `Alt+S`), usando o currículo e a vaga do usuário.

**Architecture:** O servidor mantém, por sessão, um `SuggestionEngine`: recebe cada fala encerrada, detecta perguntas do canal `them`, monta o prompt (modo + currículo + vaga + contexto + últimas 20 falas) e chama o OpenRouter em streaming. A resposta vem no formato `<en>…</en><pt>…</pt>`; um `TagStreamParser` a converte em eventos `suggestion.delta` por idioma. Na extensão, o store guarda a sugestão atual e o painel a exibe num cartão fixo no rodapé.

**Tech Stack:** o dos marcos anteriores + OpenRouter (`POST https://openrouter.ai/api/v1/chat/completions`, `stream: true`, SSE compatível com OpenAI) com o modelo `anthropic/claude-haiku-4.5` (configurável).

**Spec:** `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md` — implementa §4.6 com as alterações abaixo.

**Decisões do usuário em 2026-09-25 que alteram o spec:**
- Provedor: OpenRouter (conta paga do usuário) em vez da API da Anthropic direta; modelo `anthropic/claude-haiku-4.5` em `SUGGESTION_MODEL`.
- Gatilho: além do pedido manual, **sugestão automática quando o participante termina uma pergunta** (o spec previa só sob demanda).
- Contexto: dois campos novos, **currículo/resumo profissional** e **descrição da vaga** (até 8.000 caracteres cada), salvos no painel e enviados ao servidor.
- Tamanho: resposta curta para falar — 2 a 4 frases em inglês simples.
- Sem retomada de sessão (marco 2 adiado): pedido duplicado com o mesmo `requestId` é ignorado, em vez de reenviar o resultado guardado.

## Global Constraints

- Uma geração por vez por sessão. Regras, nesta ordem:
  - `requestId` já visto → ignorado.
  - Pedido **manual** com geração **manual** em andamento → `suggestion.error { code: "busy" }`.
  - Pedido **manual** a menos de 2 s do anterior manual → `suggestion.error { code: "rate_limited" }`.
  - Pedido **automático** com geração **manual** em andamento → ignorado (não atrapalha o pedido do usuário).
  - Qualquer pedido com geração **automática** em andamento → a automática é cancelada (`suggestion.error { code: "cancelled" }`) e a nova começa.
- Pergunta (gatilho automático): fala encerrada do canal `them`, não interrompida, com ≥ 3 palavras, que termina com `?` ou cuja última frase começa com uma expressão interrogativa (lista em `question-detector.ts`).
- Congelamento: modo, contexto, currículo, vaga e as últimas **20** falas encerradas são copiados no instante do pedido; `session.update` vale para os próximos.
- Saída do modelo: exatamente `<en>…</en><pt>…</pt>`; ambos os blocos não vazios, senão `invalid_output`. `pt` é a tradução em português do Brasil de `en`.
- Prazo de **15 s** por geração → `timeout`. Fim da sessão cancela a geração em andamento → `cancelled`.
- OpenRouter: `Authorization: Bearer <OPENROUTER_API_KEY>`, corpo `{ model, messages, stream: true, max_tokens: 400, temperature: 0.4 }`; linhas SSE `data: {...}` com `choices[0].delta.content`, comentários iniciados por `:` ignorados, fim em `data: [DONE]`, erro no meio do stream como objeto com `error`.
- Sem `OPENROUTER_API_KEY` → sugestão falsa com aviso no log.
- Currículo e vaga vão ao servidor e ao provedor de IA só para gerar sugestões; não são gravados. Logs sem conteúdo da conversa nem do currículo.
- Textos da interface em português do Brasil.

## Review Focus

1. Entrevistador faz duas perguntas seguidas → a sugestão da primeira é cancelada e a da segunda aparece; o painel nunca mistura texto das duas (testes nas Tasks 5 e 7).
2. Usuário aperta `Alt+S` várias vezes rápido → uma geração, as demais recusadas com aviso curto, sem travar (teste na Task 5).
3. OpenRouter lento, fora do ar, sem crédito ou com chave errada → mensagem clara no cartão e a legenda segue normal (testes nas Tasks 3 e 5).
4. Modelo devolve texto fora do formato → `invalid_output`, nada quebrado aparece no painel (testes nas Tasks 1 e 5).
5. Usuário para a sessão durante uma geração → geração cancelada, sem eventos depois de `session.ended` (teste na Task 6).

---

## Estrutura de arquivos

```
packages/shared/src/messages.ts            + session.start (profile, job), session.update, suggest.request;
                                             eventos suggestion.started/delta/done/error

apps/server/src/suggest/
  tag-stream.ts (+test)                    <en>…</en><pt>…</pt> em streaming → deltas por idioma (puro)
  question-detector.ts (+test)             a fala do participante é uma pergunta? (puro)
  prompt.ts (+test)                        mensagens para o modelo a partir do contexto congelado (puro)
  openrouter.ts (+test)                    cliente SSE do OpenRouter + sugestor falso
  suggestion-engine.ts (+test)             regras de gatilho, concorrência, prazo, eventos
apps/server/src/
  channel-pipeline.ts                      avisa cada fala encerrada (texto completo)
  session.ts                               contexto mutável, engine, update, pedido manual
  gateway.ts                               session.update e suggest.request
  config.ts, providers.ts, main.ts, .env.example   OPENROUTER_API_KEY, SUGGESTION_MODEL
  session-suggestions.test.ts              integração ponta a ponta

apps/extension/src/
  offscreen/session-store.ts (+test)       sugestão atual no estado
  offscreen/session-controller.ts (+test)  requestSuggestion(), update(), StartParams com profile/job
  offscreen/message-handler.ts (+test)     mensagens suggest e update
  messaging.ts                             tipos das mensagens novas
  background/service-worker.ts             comando Alt+S
  public/manifest.json                     commands.suggest
  sidepanel/suggestion-view.ts (+test)     texto e estado do cartão (puro)
  sidepanel.html, sidepanel/main.ts, sidepanel/sidepanel.css   campos currículo/vaga, cartão de sugestão
README.md                                  chave do OpenRouter e roteiro do marco 5
```

---

### Task 1: Protocolo das sugestões

**Files:** Modify `packages/shared/src/messages.ts`, `packages/shared/src/messages.test.ts`

**Interfaces — Produces:**
- `MAX_PROFILE_CHARS = 8000`, `MAX_JOB_CHARS = 8000`, `SUGGESTION_TRIGGERS = ["auto", "manual"]`, `SUGGESTION_ERROR_CODES = ["busy", "rate_limited", "timeout", "invalid_output", "provider", "cancelled"]`
- `ClientMessage` ganha: `session.start` com `profile?: string`, `job?: string`; `{ type: "session.update"; mode?; context?; profile?; job? }`; `{ type: "suggest.request"; requestId: string }` (1–64 caracteres)
- Eventos: `{ type: "suggestion.started"; requestId; trigger: "auto" | "manual"; basedOnUtteranceId: string | null }`, `{ type: "suggestion.delta"; requestId; lang: "en" | "pt"; text }`, `{ type: "suggestion.done"; requestId; en; pt }`, `{ type: "suggestion.error"; requestId; code }`

- [ ] **Step 1: Testes**

Acrescentar a `messages.test.ts`:

```ts
describe("mensagens de sugestão", () => {
  it("session.start aceita currículo e vaga opcionais, com limite", () => {
    const start = { type: "session.start", token: "k", mode: "interview", context: "", profile: "Dev backend 8 anos", job: "Senior Backend" };
    expect(parseClientMessage(JSON.stringify(start))).toEqual(start);
    expect(parseClientMessage(JSON.stringify({ ...start, profile: "x".repeat(MAX_PROFILE_CHARS + 1) }))).toBeNull();
  });

  it("aceita session.update parcial e suggest.request", () => {
    expect(parseClientMessage('{"type":"session.update","job":"Nova vaga"}')).toEqual({ type: "session.update", job: "Nova vaga" });
    expect(parseClientMessage('{"type":"suggest.request","requestId":"abc"}')).toEqual({ type: "suggest.request", requestId: "abc" });
    expect(parseClientMessage('{"type":"suggest.request","requestId":""}')).toBeNull();
  });

  it("aceita os eventos de sugestão", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, requestId: "r1" };
    const events = [
      { ...base, type: "suggestion.started", trigger: "auto", basedOnUtteranceId: "them-3" },
      { ...base, type: "suggestion.started", trigger: "manual", basedOnUtteranceId: null },
      { ...base, type: "suggestion.delta", lang: "en", text: "Sure" },
      { ...base, type: "suggestion.done", en: "Sure.", pt: "Claro." },
      { ...base, type: "suggestion.error", code: "busy" },
    ];
    for (const event of events) expect(parseServerMessage(JSON.stringify(event))).toEqual(event);
    expect(parseServerMessage(JSON.stringify({ ...base, type: "suggestion.error", code: "exploded" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...base, type: "suggestion.delta", lang: "es", text: "x" }))).toBeNull();
  });
});
```

(importar `MAX_PROFILE_CHARS` de `./messages`.)

- [ ] **Step 2: Rodar e confirmar a falha** — `pnpm test packages/shared/src/messages.test.ts` → FAIL nos três testes novos.

- [ ] **Step 3: Implementar** — em `messages.ts`:
  - constantes `MAX_PROFILE_CHARS`, `MAX_JOB_CHARS`, `SUGGESTION_TRIGGERS`, `SUGGESTION_ERROR_CODES` (e tipos `SuggestionTrigger`, `SuggestionErrorCode`);
  - no `session.start`: `profile: z.string().max(MAX_PROFILE_CHARS).optional()`, `job: z.string().max(MAX_JOB_CHARS).optional()`;
  - novos membros do `clientMessageSchema`:

```ts
  z.object({
    type: z.literal("session.update"),
    mode: z.enum(MODES).optional(),
    context: z.string().max(MAX_CONTEXT_CHARS).optional(),
    profile: z.string().max(MAX_PROFILE_CHARS).optional(),
    job: z.string().max(MAX_JOB_CHARS).optional(),
  }),
  z.object({ type: z.literal("suggest.request"), requestId: z.string().min(1).max(64) }),
```

  - corpos de evento (com `extend(envelopeShape)` no `serverMessageSchema` e na união `ServerEventBody`):

```ts
const requestIdSchema = z.string().min(1).max(64);

const suggestionStartedBody = z.object({
  type: z.literal("suggestion.started"),
  requestId: requestIdSchema,
  trigger: z.enum(SUGGESTION_TRIGGERS),
  basedOnUtteranceId: z.string().min(1).nullable(),
});

const suggestionDeltaBody = z.object({
  type: z.literal("suggestion.delta"),
  requestId: requestIdSchema,
  lang: z.enum(["en", "pt"]),
  text: z.string(),
});

const suggestionDoneBody = z.object({
  type: z.literal("suggestion.done"),
  requestId: requestIdSchema,
  en: z.string().min(1),
  pt: z.string().min(1),
});

const suggestionErrorBody = z.object({
  type: z.literal("suggestion.error"),
  requestId: requestIdSchema,
  code: z.enum(SUGGESTION_ERROR_CODES),
});
```

  O store da extensão ganha `default` temporário no `switch` de eventos (como na Task 1 dos marcos 3–4) até a Task 7; o gateway fecha com `4400` as mensagens novas até a Task 6 (comportamento atual de mensagem desconhecida).

- [ ] **Step 4:** `pnpm test && pnpm -r typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(shared): mensagens e eventos de sugestão de resposta`.

---

### Task 2: Parser de tags em streaming, detector de pergunta e prompt

**Files:** Create `apps/server/src/suggest/tag-stream.ts`, `question-detector.ts`, `prompt.ts` + testes.

**Interfaces — Produces:**
- `type SuggestionLang = "en" | "pt"`, `class TagStreamParser { push(chunk: string): Array<{ lang; text }>; result(): { en: string; pt: string } }`
- `looksLikeQuestion(text: string): boolean`
- `interface TranscriptLine { channel: Channel; text: string }`, `interface SuggestionContext { mode: Mode; context: string; profile: string; job: string; transcript: TranscriptLine[] }`, `TRANSCRIPT_LINES = 20`, `interface ChatMessage { role: "system" | "user"; content: string }`, `buildSuggestionMessages(ctx: SuggestionContext): ChatMessage[]`

- [ ] **Step 1: Testes**

`tag-stream.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TagStreamParser } from "./tag-stream";

const RAW = "<en>Sure, I led that project.</en><pt>Claro, eu liderei esse projeto.</pt>";

function feed(chunks: string[]) {
  const parser = new TagStreamParser();
  const deltas = chunks.flatMap((c) => parser.push(c));
  return { parser, deltas };
}

describe("TagStreamParser", () => {
  it("separa inglês e português de uma resposta inteira", () => {
    const { parser } = feed([RAW]);
    expect(parser.result()).toEqual({ en: "Sure, I led that project.", pt: "Claro, eu liderei esse projeto." });
  });

  it("dá o mesmo resultado qualquer que seja o ponto de corte dos pedaços", () => {
    for (let cut = 1; cut < RAW.length; cut++) {
      const { parser, deltas } = feed([RAW.slice(0, cut), RAW.slice(cut)]);
      expect(parser.result()).toEqual({ en: "Sure, I led that project.", pt: "Claro, eu liderei esse projeto." });
      expect(deltas.filter((d) => d.lang === "en").map((d) => d.text).join("")).toBe("Sure, I led that project.");
    }
  });

  it("entrega o texto aos poucos, caractere a caractere", () => {
    const { deltas } = feed([...RAW]);
    expect(deltas.filter((d) => d.lang === "pt").map((d) => d.text).join("")).toBe("Claro, eu liderei esse projeto.");
  });

  it("ignora texto fora das tags e mantém '<' que não é tag", () => {
    const { parser } = feed(["Here you go:\n<en>Costs < 5 dollars.</en>\n<pt>Custa < 5 dólares.</pt> done"]);
    expect(parser.result()).toEqual({ en: "Costs < 5 dollars.", pt: "Custa < 5 dólares." });
  });

  it("resultado vazio quando o modelo não usa as tags", () => {
    expect(feed(["Sure, I led that project."]).parser.result()).toEqual({ en: "", pt: "" });
  });
});
```

`question-detector.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { looksLikeQuestion } from "./question-detector";

describe("looksLikeQuestion", () => {
  it("reconhece perguntas com ponto de interrogação", () => {
    expect(looksLikeQuestion("How was your weekend?")).toBe(true);
    expect(looksLikeQuestion("So you worked with Kafka before?")).toBe(true);
  });

  it("reconhece pedidos típicos de entrevista sem interrogação", () => {
    expect(looksLikeQuestion("Great. Tell me about yourself.")).toBe(true);
    expect(looksLikeQuestion("Walk me through your last project")).toBe(true);
    expect(looksLikeQuestion("Could you describe a conflict with a teammate.")).toBe(true);
  });

  it("não dispara para afirmações, frases curtas ou perguntas no meio", () => {
    expect(looksLikeQuestion("That sounds great, thanks for sharing.")).toBe(false);
    expect(looksLikeQuestion("Okay?")).toBe(false);
    expect(looksLikeQuestion("What a day. Anyway, let's move on to the next topic.")).toBe(false);
  });
});
```

`prompt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_LINES, buildSuggestionMessages, type SuggestionContext } from "./prompt";

const base: SuggestionContext = {
  mode: "interview",
  context: "Entrevista na Acme",
  profile: "Backend developer, 8 years, Node and Kafka at Nubank.",
  job: "Senior Backend Engineer, payments.",
  transcript: [
    { channel: "them", text: "Tell me about yourself." },
    { channel: "me", text: "Sure." },
  ],
};

describe("buildSuggestionMessages", () => {
  it("instrui formato, tamanho e modo no system", () => {
    const [system] = buildSuggestionMessages(base);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("<en>");
    expect(system?.content).toContain("<pt>");
    expect(system?.content).toContain("2 to 4");
    expect(system?.content.toLowerCase()).toContain("job interview");
  });

  it("inclui currículo, vaga, contexto e a conversa rotulada", () => {
    const user = buildSuggestionMessages(base)[1]?.content ?? "";
    expect(user).toContain("Nubank");
    expect(user).toContain("Senior Backend Engineer");
    expect(user).toContain("Entrevista na Acme");
    expect(user).toContain("THEM: Tell me about yourself.\nME: Sure.");
  });

  it("omite seções vazias", () => {
    const user = buildSuggestionMessages({ ...base, profile: "", job: "", context: "" })[1]?.content ?? "";
    expect(user).not.toContain("PROFILE");
    expect(user).not.toContain("JOB");
    expect(user).not.toContain("CONTEXT");
  });

  it("usa só as últimas falas", () => {
    const transcript = Array.from({ length: 30 }, (_, i) => ({ channel: "them" as const, text: `line ${i}` }));
    const user = buildSuggestionMessages({ ...base, transcript })[1]?.content ?? "";
    expect(user).not.toContain("line 9\n");
    expect(user).toContain(`line ${30 - TRANSCRIPT_LINES}`);
    expect(user).toContain("line 29");
  });

  it("muda a orientação conforme o modo", () => {
    const sales = buildSuggestionMessages({ ...base, mode: "sales" })[0]?.content ?? "";
    expect(sales.toLowerCase()).toContain("sales");
  });
});
```

- [ ] **Step 2:** rodar → FAIL (módulos inexistentes).

- [ ] **Step 3: Implementar**

`tag-stream.ts`:

```ts
export type SuggestionLang = "en" | "pt";

const OPEN = { en: "<en>", pt: "<pt>" } as const;
const CLOSE = { en: "</en>", pt: "</pt>" } as const;

// Lê <en>…</en><pt>…</pt> em pedaços arbitrários e devolve o texto de cada idioma assim que é seguro.
export class TagStreamParser {
  private buffer = "";
  private current: SuggestionLang | null = null;
  private readonly text = { en: "", pt: "" };

  push(chunk: string): Array<{ lang: SuggestionLang; text: string }> {
    this.buffer += chunk;
    const deltas: Array<{ lang: SuggestionLang; text: string }> = [];
    for (;;) {
      if (this.current === null) {
        const en = this.buffer.indexOf(OPEN.en);
        const pt = this.buffer.indexOf(OPEN.pt);
        const next = [en, pt].filter((i) => i >= 0).sort((a, b) => a - b)[0];
        if (next === undefined) {
          // Guarda só o que ainda pode ser o começo de uma tag.
          const lt = this.buffer.lastIndexOf("<");
          this.buffer = lt >= 0 && this.buffer.length - lt < OPEN.en.length ? this.buffer.slice(lt) : "";
          return deltas;
        }
        this.current = next === en ? "en" : "pt";
        this.buffer = this.buffer.slice(next + OPEN[this.current].length);
        continue;
      }
      const close = CLOSE[this.current];
      const end = this.buffer.indexOf(close);
      if (end >= 0) {
        this.emit(deltas, this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + close.length);
        this.current = null;
        continue;
      }
      // Segura o sufixo que pode ser o começo da tag de fechamento.
      const lt = this.buffer.lastIndexOf("<");
      const hold = lt >= 0 && close.startsWith(this.buffer.slice(lt)) ? lt : this.buffer.length;
      this.emit(deltas, this.buffer.slice(0, hold));
      this.buffer = this.buffer.slice(hold);
      return deltas;
    }
  }

  result(): { en: string; pt: string } {
    return { en: this.text.en.trim(), pt: this.text.pt.trim() };
  }

  private emit(deltas: Array<{ lang: SuggestionLang; text: string }>, text: string): void {
    if (!text || this.current === null) return;
    this.text[this.current] += text;
    deltas.push({ lang: this.current, text });
  }
}
```

`question-detector.ts`:

```ts
const QUESTION_STARTERS = [
  "what", "why", "how", "when", "where", "who", "which",
  "tell me", "tell us", "can you", "could you", "would you", "will you",
  "do you", "did you", "have you", "are you", "were you", "is there", "is it",
  "walk me through", "walk us through", "describe", "explain", "give me", "share",
];

function lastSentence(text: string): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter((p) => p.trim().length > 0);
  return (parts[parts.length - 1] ?? "").trim();
}

/** Fala do participante que pede uma resposta: termina com "?" ou a última frase começa com expressão interrogativa. */
export function looksLikeQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (normalized.split(/\s+/).filter(Boolean).length < 3) return false;
  if (normalized.endsWith("?")) return true;
  const last = lastSentence(normalized).replace(/^(so|and|okay|ok|great|alright|well|now),?\s+/, "");
  return QUESTION_STARTERS.some((starter) => last.startsWith(`${starter} `));
}
```

`prompt.ts`:

```ts
import type { Channel, Mode } from "@snowspeak/shared";

export const TRANSCRIPT_LINES = 20;

export interface TranscriptLine {
  channel: Channel;
  text: string;
}

export interface SuggestionContext {
  mode: Mode;
  context: string;
  profile: string;
  job: string;
  transcript: TranscriptLine[];
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const MODE_GUIDANCE: Record<Mode, string> = {
  interview:
    "The user is a candidate in a job interview. Answer as a confident, honest candidate: highlight relevant experience from the profile and connect it to the job.",
  work: "The user is in a work meeting with colleagues. Be clear, collaborative and professional.",
  sales: "The user is in a sales or customer call. Be helpful and persuasive without being pushy; move the conversation toward the next step.",
  relationship: "The user is in a personal, friendly conversation. Be warm, natural and genuine.",
};

const SYSTEM_RULES = `You help a Brazilian user reply in real time during a live English conversation.
Write the reply the user should say next, in the first person, answering the other person's last question or point.
Rules:
- 2 to 4 short sentences in simple, natural spoken English that is easy to read aloud.
- Ground the reply in the PROFILE when it is relevant. Never invent employers, numbers or facts that are not in the PROFILE; if something is missing, stay general.
- Output exactly <en>REPLY</en><pt>TRADUCAO</pt>, where TRADUCAO is the Brazilian Portuguese translation of REPLY. Output nothing else.`;

export function buildSuggestionMessages(ctx: SuggestionContext): ChatMessage[] {
  const sections: string[] = [];
  if (ctx.profile.trim()) sections.push(`PROFILE:\n${ctx.profile.trim()}`);
  if (ctx.job.trim()) sections.push(`JOB:\n${ctx.job.trim()}`);
  if (ctx.context.trim()) sections.push(`CONTEXT:\n${ctx.context.trim()}`);
  const conversation = ctx.transcript
    .slice(-TRANSCRIPT_LINES)
    .map((line) => `${line.channel === "them" ? "THEM" : "ME"}: ${line.text}`)
    .join("\n");
  sections.push(`CONVERSATION (most recent last):\n${conversation || "(nothing yet)"}`);
  sections.push("Write the suggested reply now.");
  return [
    { role: "system", content: `${SYSTEM_RULES}\n\n${MODE_GUIDANCE[ctx.mode]}` },
    { role: "user", content: sections.join("\n\n") },
  ];
}
```

- [ ] **Step 4:** `pnpm test apps/server/src/suggest && pnpm --filter @snowspeak/server typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(server): parser de tags, detector de pergunta e prompt das sugestões`.

---

### Task 3: Cliente do OpenRouter

**Files:** Create `apps/server/src/suggest/openrouter.ts` + `openrouter.test.ts`

**Interfaces — Produces:**
- `interface Suggester { stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string> }`
- `OPENROUTER_URL`, `createOpenRouterSuggester(options: { apiKey: string; model: string; url?: string }): Suggester`
- `createFakeSuggester(): Suggester`

- [ ] **Step 1: Testes** (servidor HTTP local que responde em SSE)

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenRouterSuggester } from "./openrouter";

let server: Server | null = null;
let lastRequest: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | null = null;

async function startFake(handler: (res: ServerResponse) => void): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      handler(res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/chat/completions`;
}

const sse = (res: ServerResponse, lines: string[]) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const line of lines) res.write(`${line}\n\n`);
  res.end();
};
const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`;

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const piece of iterable) out.push(piece);
  return out;
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("OpenRouterSuggester", () => {
  it("envia modelo, mensagens e stream com a chave, e entrega os pedaços", async () => {
    const url = await startFake((res) => sse(res, [": OPENROUTER PROCESSING", chunk("<en>Hi"), chunk(" there</en>"), "data: [DONE]"]));
    const suggester = createOpenRouterSuggester({ apiKey: "or-key", model: "anthropic/claude-haiku-4.5", url });
    const pieces = await collect(suggester.stream([{ role: "user", content: "x" }], new AbortController().signal));
    expect(pieces).toEqual(["<en>Hi", " there</en>"]);
    expect(lastRequest?.headers.authorization).toBe("Bearer or-key");
    expect(lastRequest?.body).toMatchObject({ model: "anthropic/claude-haiku-4.5", stream: true, max_tokens: 400, messages: [{ role: "user", content: "x" }] });
  });

  it("junta linhas SSE que chegam quebradas entre pacotes", async () => {
    const url = await startFake((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const line = `${chunk("abc")}\n\n`;
      res.write(line.slice(0, 10));
      setTimeout(() => {
        res.write(line.slice(10));
        res.end("data: [DONE]\n\n");
      }, 10);
    });
    const pieces = await collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal));
    expect(pieces).toEqual(["abc"]);
  });

  it("falha com o status quando a API recusa (chave, crédito)", async () => {
    const url = await startFake((res) => res.writeHead(402, { "content-type": "application/json" }).end('{"error":{"message":"no credits"}}'));
    await expect(collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal))).rejects.toThrow("402");
  });

  it("falha quando o provedor manda erro no meio do stream", async () => {
    const url = await startFake((res) => sse(res, [chunk("<en>Hi"), `data: ${JSON.stringify({ error: { message: "overloaded" }, choices: [{ finish_reason: "error" }] })}`]));
    await expect(collect(createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], new AbortController().signal))).rejects.toThrow("overloaded");
  });

  it("para quando o pedido é cancelado", async () => {
    const url = await startFake((res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`${chunk("<en>Hi")}\n\n`);
    });
    const controller = new AbortController();
    const pieces: string[] = [];
    const run = (async () => {
      for await (const piece of createOpenRouterSuggester({ apiKey: "k", model: "m", url }).stream([], controller.signal)) {
        pieces.push(piece);
        controller.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(pieces).toEqual(["<en>Hi"]);
  });
});
```

- [ ] **Step 2:** rodar → FAIL.

- [ ] **Step 3: Implementar**

```ts
import type { ChatMessage } from "./prompt";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface Suggester {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
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
      if (!response.ok || !response.body) throw new Error(`OpenRouter respondeu HTTP ${response.status}`);

      const decoder = new TextDecoder();
      let buffer = "";
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(bytes, { stream: true });
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
    },
  };
}

// Sem OPENROUTER_API_KEY: resposta fixa, em pedaços, para testar o caminho completo.
export function createFakeSuggester(): Suggester {
  return {
    async *stream() {
      for (const piece of ["<en>[sugestão falsa] Sure, ", "I'd be happy to talk about that.</en>", "<pt>[sugestão falsa] Claro, falo sobre isso com prazer.</pt>"]) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        yield piece;
      }
    },
  };
}
```

- [ ] **Step 4:** `pnpm test apps/server/src/suggest && pnpm --filter @snowspeak/server typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(server): cliente em streaming do OpenRouter para sugestões`.

---

### Task 4: Motor de sugestões

**Files:** Create `apps/server/src/suggest/suggestion-engine.ts` + `suggestion-engine.test.ts`

**Interfaces:**
- Consumes: `Suggester`, `TagStreamParser`, `looksLikeQuestion`, `buildSuggestionMessages`, `TranscriptLine`.
- Produces: `SUGGESTION_TIMEOUT_MS = 15000`, `MANUAL_MIN_INTERVAL_MS = 2000`, `MAX_TRANSCRIPT = 40`;
  `interface SuggestionSettings { mode: Mode; context: string; profile: string; job: string }`;
  `class SuggestionEngine { constructor(deps: { suggester; emit(body: ServerEventBody): void; settings(): SuggestionSettings; now?(): number; timeoutMs?: number }); addUtterance(u: { channel; utteranceId; text; interrupted }): void; request(requestId: string): void; close(): void }`

- [ ] **Step 1: Testes** — com um sugestor roteirizado:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import type { ChatMessage } from "./prompt";
import type { Suggester } from "./openrouter";
import { MANUAL_MIN_INTERVAL_MS, SuggestionEngine } from "./suggestion-engine";

type Script = (messages: ChatMessage[], signal: AbortSignal) => AsyncIterable<string>;

function scripted(script: Script): Suggester & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return { calls, stream: (messages, signal) => (calls.push(messages), script(messages, signal)) };
}

const answer = (en: string, pt: string): Script =>
  async function* () {
    yield `<en>${en}</en>`;
    yield `<pt>${pt}</pt>`;
  };

// Só termina quando cancelado.
const hanging: Script = async function* (_m, signal) {
  yield "<en>Partial";
  await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function setup(script: Script, options: { now?: () => number; timeoutMs?: number } = {}) {
  const events: ServerEventBody[] = [];
  const suggester = scripted(script);
  const engine = new SuggestionEngine({
    suggester,
    emit: (body) => events.push(body),
    settings: () => ({ mode: "interview", context: "", profile: "Node dev at Nubank", job: "Backend" }),
    ...options,
  });
  const types = () => events.map((e) => e.type);
  const of = (requestId: string) => events.filter((e) => "requestId" in e && e.requestId === requestId);
  return { engine, events, suggester, types, of };
}

describe("SuggestionEngine", () => {
  afterEach(() => vi.useRealTimers());

  it("pedido manual: started, deltas e done com inglês e português", async () => {
    const t = setup(answer("Sure.", "Claro."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Nice to meet you.", interrupted: false });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1")).toEqual([
      { type: "suggestion.started", requestId: "r1", trigger: "manual", basedOnUtteranceId: "them-1" },
      { type: "suggestion.delta", requestId: "r1", lang: "en", text: "Sure." },
      { type: "suggestion.delta", requestId: "r1", lang: "pt", text: "Claro." },
      { type: "suggestion.done", requestId: "r1", en: "Sure.", pt: "Claro." },
    ]);
  });

  it("gera sozinho quando o participante termina uma pergunta", async () => {
    const t = setup(answer("I build APIs.", "Eu construo APIs."));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "Tell me about yourself.", interrupted: false });
    await settle();
    expect(t.events[0]).toEqual({ type: "suggestion.started", requestId: "auto-1", trigger: "auto", basedOnUtteranceId: "them-2" });
    expect(t.types()).toContain("suggestion.done");
  });

  it("não gera sozinho para afirmações, falas do usuário ou falas interrompidas", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "That sounds great, thanks.", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "What do you mean by that?", interrupted: false });
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "What would you do if", interrupted: true });
    await settle();
    expect(t.events).toEqual([]);
  });

  it("uma pergunta nova cancela a sugestão automática em andamento", async () => {
    const t = setup(hanging);
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "How was your weekend?", interrupted: false });
    await settle();
    t.suggester.stream = answer("Second.", "Segunda.");
    t.engine.addUtterance({ channel: "them", utteranceId: "them-2", text: "What is your biggest strength?", interrupted: false });
    await settle();
    expect(t.of("auto-1").at(-1)).toEqual({ type: "suggestion.error", requestId: "auto-1", code: "cancelled" });
    expect(t.of("auto-2").at(-1)).toEqual({ type: "suggestion.done", requestId: "auto-2", en: "Second.", pt: "Segunda." });
  });

  it("pedido manual recusado enquanto outro manual está em andamento", async () => {
    let now = 0;
    const t = setup(hanging, { now: () => now });
    t.engine.request("r1");
    now = MANUAL_MIN_INTERVAL_MS + 1;
    t.engine.request("r2");
    await settle();
    expect(t.of("r2")).toEqual([{ type: "suggestion.error", requestId: "r2", code: "busy" }]);
  });

  it("sugestão automática não atrapalha um pedido manual em andamento", async () => {
    const t = setup(hanging);
    t.engine.request("r1");
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Why do you want this job?", interrupted: false });
    await settle();
    expect(t.events.filter((e) => e.type === "suggestion.started")).toHaveLength(1);
  });

  it("recusa pedidos manuais muito próximos e ignora requestId repetido", async () => {
    let now = 0;
    const t = setup(answer("x", "y"), { now: () => now });
    t.engine.request("r1");
    await settle();
    now = MANUAL_MIN_INTERVAL_MS - 1;
    t.engine.request("r2");
    t.engine.request("r1");
    await settle();
    expect(t.of("r2")).toEqual([{ type: "suggestion.error", requestId: "r2", code: "rate_limited" }]);
    expect(t.of("r1").filter((e) => e.type === "suggestion.started")).toHaveLength(1);
  });

  it("resposta sem os dois blocos vira invalid_output", async () => {
    const t = setup(async function* () {
      yield "<en>Only English.</en>";
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "invalid_output" });
  });

  it("falha do provedor vira provider", async () => {
    const t = setup(async function* () {
      throw new Error("HTTP 402");
    });
    t.engine.request("r1");
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "provider" });
  });

  it("estoura o prazo", async () => {
    const t = setup(hanging, { timeoutMs: 20 });
    t.engine.request("r1");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "timeout" });
  });

  it("close cancela a geração em andamento", async () => {
    const t = setup(hanging);
    t.engine.request("r1");
    await settle();
    t.engine.close();
    await settle();
    expect(t.of("r1").at(-1)).toEqual({ type: "suggestion.error", requestId: "r1", code: "cancelled" });
    t.engine.request("r3");
    await settle();
    expect(t.of("r3")).toEqual([]);
  });

  it("congela o contexto e a conversa no instante do pedido", async () => {
    const t = setup(answer("x", "y"));
    t.engine.addUtterance({ channel: "them", utteranceId: "them-1", text: "Nice to meet you.", interrupted: false });
    t.engine.addUtterance({ channel: "me", utteranceId: "me-1", text: "Likewise.", interrupted: false });
    t.engine.request("r1");
    await settle();
    const user = t.suggester.calls[0]?.[1]?.content ?? "";
    expect(user).toContain("Nubank");
    expect(user).toContain("THEM: Nice to meet you.\nME: Likewise.");
  });
});
```

- [ ] **Step 2:** rodar → FAIL.

- [ ] **Step 3: Implementar**

```ts
import type { Channel, Mode, ServerEventBody, SuggestionErrorCode, SuggestionTrigger } from "@snowspeak/shared";
import type { Suggester } from "./openrouter";
import { buildSuggestionMessages, type TranscriptLine } from "./prompt";
import { looksLikeQuestion } from "./question-detector";
import { TagStreamParser } from "./tag-stream";

export const SUGGESTION_TIMEOUT_MS = 15_000;
export const MANUAL_MIN_INTERVAL_MS = 2_000;
export const MAX_TRANSCRIPT = 40;

export interface SuggestionSettings {
  mode: Mode;
  context: string;
  profile: string;
  job: string;
}

export interface SuggestionEngineDeps {
  suggester: Suggester;
  emit: (body: ServerEventBody) => void;
  settings: () => SuggestionSettings;
  now?: () => number;
  timeoutMs?: number;
}

interface Generation {
  requestId: string;
  trigger: SuggestionTrigger;
  controller: AbortController;
  /** Motivo do cancelamento, quando cancelada por nós. */
  reason: "cancelled" | "timeout" | null;
}

export class SuggestionEngine {
  private readonly transcript: Array<TranscriptLine & { utteranceId: string }> = [];
  private readonly seen = new Set<string>();
  private inflight: Generation | null = null;
  private lastManualAt = Number.NEGATIVE_INFINITY;
  private autoCount = 0;
  private closed = false;

  constructor(private readonly deps: SuggestionEngineDeps) {}

  addUtterance(utterance: { channel: Channel; utteranceId: string; text: string; interrupted: boolean }): void {
    if (this.closed || !utterance.text.trim()) return;
    this.transcript.push({ channel: utterance.channel, text: utterance.text.trim(), utteranceId: utterance.utteranceId });
    if (this.transcript.length > MAX_TRANSCRIPT) this.transcript.shift();
    if (utterance.channel !== "them" || utterance.interrupted || !looksLikeQuestion(utterance.text)) return;
    // Pedido do usuário em andamento tem prioridade sobre a sugestão automática.
    if (this.inflight?.trigger === "manual") return;
    this.autoCount += 1;
    this.start(`auto-${this.autoCount}`, "auto", utterance.utteranceId);
  }

  request(requestId: string): void {
    if (this.closed || this.seen.has(requestId)) return;
    if (this.inflight?.trigger === "manual") {
      this.seen.add(requestId);
      this.deps.emit({ type: "suggestion.error", requestId, code: "busy" });
      return;
    }
    const now = (this.deps.now ?? Date.now)();
    if (now - this.lastManualAt < MANUAL_MIN_INTERVAL_MS) {
      this.seen.add(requestId);
      this.deps.emit({ type: "suggestion.error", requestId, code: "rate_limited" });
      return;
    }
    this.lastManualAt = now;
    const lastThem = [...this.transcript].reverse().find((line) => line.channel === "them");
    this.start(requestId, "manual", lastThem?.utteranceId ?? null);
  }

  close(): void {
    this.closed = true;
    this.cancel("cancelled");
  }

  private cancel(reason: "cancelled" | "timeout"): void {
    const generation = this.inflight;
    if (!generation) return;
    generation.reason = reason;
    generation.controller.abort(new Error(reason));
  }

  private start(requestId: string, trigger: SuggestionTrigger, basedOnUtteranceId: string | null): void {
    this.cancel("cancelled");
    this.seen.add(requestId);
    const generation: Generation = { requestId, trigger, controller: new AbortController(), reason: null };
    this.inflight = generation;
    this.deps.emit({ type: "suggestion.started", requestId, trigger, basedOnUtteranceId });

    // Congela contexto e conversa no instante do pedido.
    const messages = buildSuggestionMessages({ ...this.deps.settings(), transcript: this.transcript.map(({ channel, text }) => ({ channel, text })) });
    const timer = setTimeout(() => {
      if (this.inflight === generation) this.cancel("timeout");
    }, this.deps.timeoutMs ?? SUGGESTION_TIMEOUT_MS);

    void this.run(generation, messages).finally(() => {
      clearTimeout(timer);
      if (this.inflight === generation) this.inflight = null;
    });
  }

  private async run(generation: Generation, messages: ReturnType<typeof buildSuggestionMessages>): Promise<void> {
    const { requestId } = generation;
    const parser = new TagStreamParser();
    const fail = (code: SuggestionErrorCode): void => this.deps.emit({ type: "suggestion.error", requestId, code });
    try {
      for await (const chunk of this.deps.suggester.stream(messages, generation.controller.signal)) {
        if (generation.reason) break;
        for (const delta of parser.push(chunk)) this.deps.emit({ type: "suggestion.delta", requestId, ...delta });
      }
    } catch (error) {
      if (!generation.reason) {
        console.warn(`sugestão falhou: ${error instanceof Error ? error.message : String(error)}`);
        fail("provider");
        return;
      }
    }
    if (generation.reason) {
      fail(generation.reason);
      return;
    }
    const { en, pt } = parser.result();
    if (!en || !pt) {
      fail("invalid_output");
      return;
    }
    this.deps.emit({ type: "suggestion.done", requestId, en, pt });
  }
}
```

- [ ] **Step 4:** `pnpm test apps/server/src/suggest && pnpm --filter @snowspeak/server typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(server): motor de sugestões com gatilho automático, concorrência e prazo`.

---

### Task 5: Sessão, gateway e provedor

**Files:**
- Modify: `apps/server/src/channel-pipeline.ts`, `session.ts`, `gateway.ts`, `config.ts`, `providers.ts`, `main.ts`, `.env.example`, `test-support/test-client.ts`, `config.test.ts`, `providers.test.ts`, `session-transcription.test.ts`, `gateway.test.ts`
- Create: `apps/server/src/session-suggestions.test.ts`

**Interfaces:**
- `ChannelPipelineDeps.onUtterance?: (utterance: { channel; utteranceId; text; interrupted }) => void` — chamado em cada `utterance.end` com o texto completo (segmentos unidos por espaço).
- `SessionDeps` ganha `suggester: Suggester`; `new Session(deps, settings: SuggestionSettings)`; `Session.update(changes: Partial<SuggestionSettings>)`, `Session.requestSuggestion(requestId)`; `close()` também chama `engine.close()`.
- `GatewayDeps { sttFactory; suggester }`; o gateway trata `session.update` e `suggest.request` (ignorados durante o Parar).
- `ServerConfig` + `openRouterApiKey: string | null`, `suggestionModel: string` (padrão `anthropic/claude-haiku-4.5`).
- `createProviders` devolve também `suggester`; `description` acrescenta ` · sugestões: OpenRouter (<modelo>)` ou ` · sugestões: falsas (sem OPENROUTER_API_KEY)`.
- `testConfig` inclui `openRouterApiKey: null, suggestionModel: "test-model"`.

- [ ] **Step 1: Testes de integração** — `session-suggestions.test.ts`, com `createScriptedSttHub()` e um `Suggester` roteirizado que devolve `<en>OK.</en><pt>Certo.</pt>`:
  - `pergunta do participante gera sugestão automática`: STT emite segmento `"Tell me about yourself."` com `speechFinal` → cliente recebe `suggestion.started { trigger: "auto", basedOnUtteranceId: "them-1" }` e `suggestion.done { en: "OK.", pt: "Certo." }`.
  - `suggest.request gera sugestão a pedido`: cliente envia `{ type: "suggest.request", requestId: "r1" }` → `suggestion.started { trigger: "manual" }` … `suggestion.done`.
  - `session.update muda o currículo usado nas próximas sugestões`: `session.start` com `profile: "A"`, depois `session.update { profile: "Kafka expert" }`, depois pedido → o sugestor recebeu mensagens contendo `"Kafka expert"`.
  - `parar cancela a sugestão em andamento e nada chega depois de session.ended`: sugestor que só termina quando abortado; pedido; `session.stop` → última mensagem é `session.ended` e há `suggestion.error { code: "cancelled" }` antes dela.
  - Atualizar os demais testes do servidor para passar `suggester` ao gateway (ex.: `createFakeSuggester()`), e `providers.test.ts` para as novas descrições.

- [ ] **Step 2:** rodar → FAIL.

- [ ] **Step 3: Implementar**
  - `channel-pipeline.ts`: guardar os textos dos segmentos da fala aberta (`Map<utteranceId, string[]>` ou array da fala atual); em `handle()`, no `utterance.end`, chamar `deps.onUtterance?.({ channel, utteranceId, text: segmentos.join(" "), interrupted })` e limpar.
  - `session.ts`: `settings` mutável (`SuggestionSettings`); `engine = new SuggestionEngine({ suggester: deps.suggester, emit: (b) => this.emit(b), settings: () => ({ ...this.settings }), now })`; pipelines com `onUtterance: (u) => this.engine.addUtterance(u)`; `update()` mescla os campos definidos; `requestSuggestion()` → `engine.request()`; `close()` chama `engine.close()` **antes** de fechar os pipelines. No `drain()`, não mexe na sugestão (o `close()` logo depois a cancela).
  - `gateway.ts`: `new Session({ sttFactory, suggester, send }, { mode, context, profile: message.profile ?? "", job: message.job ?? "" })`; depois do `if (stopping) return;`:

```ts
    if (message?.type === "session.update") {
      session.update(message);
      return;
    }
    if (message?.type === "suggest.request") {
      session.requestSuggestion(message.requestId);
      return;
    }
```

  - `gateway.ts` (Parar): enviar `session.ended` só depois de `current.close()` para que o `suggestion.error { cancelled }` saia antes — ordem: `drain()` → `close()` → `send(session.ended)` → `ws.close(4410)`.
  - `config.ts`: `openRouterApiKey: env.OPENROUTER_API_KEY?.trim() || null`, `suggestionModel: env.SUGGESTION_MODEL?.trim() || "anthropic/claude-haiku-4.5"`.
  - `providers.ts`: `suggester` = `createOpenRouterSuggester({ apiKey, model })` ou `createFakeSuggester()`.
  - `main.ts`: passar `suggester` ao gateway.
  - `.env.example`: `OPENROUTER_API_KEY=` e `SUGGESTION_MODEL=anthropic/claude-haiku-4.5`.

- [ ] **Step 4:** `pnpm test apps/server && pnpm --filter @snowspeak/server typecheck` → PASS.
- [ ] **Step 5: Commit** — `feat(server): sugestões na sessão, session.update e suggest.request`.

---

### Task 6: Extensão — estado, controlador, mensagens e Alt+S

**Files:**
- Modify: `apps/extension/src/offscreen/session-store.ts` (+test), `session-controller.ts` (+test), `message-handler.ts` (+test), `messaging.ts`, `background/service-worker.ts`, `public/manifest.json`

**Interfaces — Produces:**
- Store: `interface SuggestionState { requestId: string; trigger: "auto" | "manual"; status: "streaming" | "done" | "error"; en: string; pt: string; basedOnUtteranceId: string | null; errorCode: SuggestionErrorCode | null }`; `SessionState.suggestion: SuggestionState | null`.
  - `suggestion.started` → nova sugestão `streaming` (substitui a anterior);
  - `suggestion.delta` / `suggestion.done` / `suggestion.error` → só se `requestId` for o da sugestão atual; `error` de outro `requestId` com código `busy`/`rate_limited` vira `notice` curto ("Aguarde a sugestão atual terminar." / "Espere um instante para pedir outra sugestão.") sem apagar a atual;
  - `starting` limpa a sugestão.
- `StartParams` ganha `profile: string; job: string`; o `session.start` envia os dois.
- `SessionController.requestSuggestion(): void` — com sessão iniciada, envia `{ type: "suggest.request", requestId }` (gerador injetável `ControllerDeps.newRequestId?: () => string`, padrão `crypto.randomUUID()`); sem sessão, ignora.
- `SessionController.update(changes: { mode?; context?; profile?; job? }): void` — com sessão iniciada envia `session.update`; também atualiza os `params` guardados.
- `OffscreenMessage` ganha `{ type: "suggest" }` e `{ type: "update"; changes: … }`; `handleOffscreenMessage` responde `{ ok: true }`.
- Manifest: `"commands": { "suggest": { "suggested_key": { "default": "Alt+S" }, "description": "Sugerir resposta" } }`; service worker: `chrome.commands.onCommand` → `{ target: "offscreen", type: "suggest" }`.

- [ ] **Step 1: Testes**
  - store: started→delta(en)→delta(pt)→done monta `{ status: "done", en, pt }`; delta de outro `requestId` é ignorado; nova `started` substitui; `error busy` de outro pedido vira aviso sem apagar a atual; `error cancelled` da atual marca `status: "error"`; `starting` limpa.
  - controlador: `requestSuggestion` com sessão iniciada envia `suggest.request` com o id do gerador; sem sessão não envia; `update` envia `session.update` e o próximo `session.start` (nova sessão) leva os valores atualizados; `session.start` leva `profile` e `job`.
  - message-handler: `suggest` chama `requestSuggestion` e responde `{ ok: true }`; `update` chama `update` com as mudanças.

- [ ] **Step 2:** rodar → FAIL. **Step 3:** implementar. **Step 4:** `pnpm test apps/extension` → PASS (o typecheck do painel pode acusar `StartParams` sem `profile/job` até a Task 7).
- [ ] **Step 5: Commit** — `feat(extension): sugestão no estado, pedido pelo controlador e atalho Alt+S`.

---

### Task 7: Painel — currículo, vaga e cartão de sugestão

**Files:**
- Create: `apps/extension/src/sidepanel/suggestion-view.ts` (+test)
- Modify: `apps/extension/sidepanel.html`, `src/sidepanel/main.ts`, `src/sidepanel/sidepanel.css`, `src/messaging.ts` (`PanelStartParams` com `profile`/`job`)

**Interfaces — Produces:** `interface SuggestionCard { visible: boolean; label: string; en: string; pt: string; pending: boolean; error: string | null }`, `suggestionCard(suggestion: SuggestionState | null): SuggestionCard`
- rótulos: `auto` → "Sugestão para a pergunta", `manual` → "Sugestão a pedido"; `streaming` → `pending: true`;
- erros: `timeout` → "A sugestão demorou demais. Tente de novo (Alt+S).", `provider` → "Não foi possível gerar a sugestão agora (serviço de IA indisponível).", `invalid_output` → "A IA respondeu fora do formato. Tente de novo (Alt+S).", `cancelled` → oculto quando substituída (o cartão mostra a nova) — se for a atual, "Sugestão cancelada.".

- [ ] **Step 1: Testes** de `suggestionCard` para cada estado acima.
- [ ] **Step 2:** rodar → FAIL. **Step 3: Implementar:**
  - HTML: nas configurações, depois de "Contexto", `<label>Seu currículo / resumo profissional <textarea id="profile" rows="5"></textarea></label>` e `<label>Descrição da vaga <textarea id="job" rows="4"></textarea></label>`, com a nota `<p class="hint">Enviados ao servidor e ao provedor de IA só para gerar sugestões; não são guardados.</p>`; `maxLength` 8000; salvos em `chrome.storage.local` junto das demais configurações.
  - HTML: depois da legenda, `<section id="suggestion" class="suggestion" hidden>` com rótulo, `<p class="suggestion-en">`, `<p class="suggestion-pt">`, mensagem de erro, e o botão `<button id="suggest">Sugerir resposta (Alt+S)</button>` visível no modo captura.
  - CSS: cartão fixo no rodapé do painel, borda na cor de destaque, inglês 17 px, português 14 px em verde; indicador "gerando…" enquanto `pending`.
  - `main.ts`: botão Sugerir → `{ target: "offscreen", type: "suggest" }`; mudanças em modo, contexto, currículo ou vaga durante a sessão → salvar e enviar `{ target: "offscreen", type: "update", changes }`; `readForm()` inclui `profile` e `job`; render do cartão a partir de `suggestionCard(state.suggestion)`.
- [ ] **Step 4:** `pnpm test && pnpm -r typecheck && pnpm --filter @snowspeak/extension build` → PASS.
- [ ] **Step 5: Commit** — `feat(extension): currículo, vaga e cartão de sugestão no painel`.

---

### Task 8: README e validação

- [ ] **Step 1:** README — `OPENROUTER_API_KEY` e `SUGGESTION_MODEL` no passo de configuração; seção "Marco 5 — roteiro de validação":
  - log mostra `sugestões: OpenRouter (anthropic/claude-haiku-4.5)`;
  - preencher currículo e vaga, modo Entrevista;
  - vídeo de entrevista em inglês: quando a entrevistadora pergunta, a sugestão aparece sozinha em ~1–2 s, curta, em inglês com português abaixo, usando o currículo;
  - `Alt+S` e o botão pedem outra sugestão a qualquer momento;
  - apertar `Alt+S` várias vezes rápido: aviso curto, uma sugestão só;
  - duas perguntas seguidas: fica a sugestão da última;
  - chave do OpenRouter errada: mensagem de serviço indisponível no cartão, legenda segue;
  - Parar durante uma sugestão: nada fica gerando;
  - chamada real no Meet.
- [ ] **Step 2: Commit** — `docs: chave do OpenRouter e roteiro do marco 5`.
- [ ] **Step 3:** validação manual com o usuário, com a chave em `apps/server/.env`.
