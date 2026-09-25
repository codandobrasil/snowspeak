# Marcos 3 e 4 — Transcrição (Deepgram) e tradução (DeepL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar no painel, em tempo real, o que os participantes dizem em inglês (Deepgram) com a tradução PT-BR logo abaixo de cada frase (DeepL), e o que o usuário diz (sem tradução).

**Architecture:** O servidor troca o STT falso por uma conexão Deepgram por canal. Um `UtteranceAssembler` transforma os resultados em parcial → segmento estável → fim de fala; um `SentenceSplitter` decide quando uma frase do canal `them` está pronta e o `DeepLTranslator` a traduz. Tudo por canal fica num `ChannelPipeline`. Na extensão, o store passa a guardar as falas (captions) e o painel as exibe como legenda.

**Tech Stack:** o do marco 1 + Deepgram Nova-3 (WebSocket `wss://api.deepgram.com/v1/listen`), DeepL API v2 (`/v2/translate`).

**Spec:** `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md` — implementa §4.3 (eventos de transcrição/tradução), §4.4, §4.5, §7 (linhas de STT e tradução) e as métricas de latência de §1. **Ordem alterada pelo usuário em 2026-09-25:** marcos 3 e 4 antes do marco 2. Portanto não há reconexão/retomada nem medição de uso neste plano; a queda do socket continua encerrando a sessão, como no marco 1.

## Global Constraints

- Deepgram: `model=nova-3`, `encoding=linear16`, `sample_rate=16000`, `channels=1`, `interim_results=true`, `smart_format=true`, `punctuate=true`, `endpointing=300`, `utterance_end_ms=1000`; canal `them` com `language=en`, canal `me` com `language=multi`. Autenticação `Authorization: Token <chave>`. Controle: `{"type":"Finalize"}`, `{"type":"CloseStream"}`.
- `is_final=false` → `transcript.partial`; `is_final=true` → `transcript.segment` (não é fim de fala); `speech_final=true` ou `UtteranceEnd` → `utterance.end`, **uma única vez** por `utteranceId`. `UtteranceEnd` com `last_word_end` anterior ao início da fala atual é ignorado.
- Fechamento forçado: `Finalize`, espera até **500 ms**; segmento com `from_finalize` encerra a fala normalmente; sem resposta → `utterance.end { interrupted: true }`. Parcial pendente **nunca** vira segmento.
- Tradução só no canal `them`. Frase enviada quando: termina com `.`, `?` ou `!` (seguido de espaço ou fim); **2,5 s** desde que o trecho pendente começou; **30 palavras**; ou `utterance.end`. `sentenceIdx` atribuído pelo servidor, estável, reinicia em 0 a cada fala.
- DeepL: `POST /v2/translate`, `Authorization: DeepL-Auth-Key <chave>`, `source_lang=EN`, `target_lang=PT-BR`, `model_type=latency_optimized`, `context` = até 2 frases anteriores do canal. Chave terminada em `:fx` → `https://api-free.deepl.com`, senão `https://api.deepl.com`. Prazo de 5 s; **1 nova tentativa**; depois `translation.error`.
- Sem chave de provedor → modo falso com aviso no log (STT com sonda de sinal do marco 1; tradução `[tradução falsa] …`).
- Chaves só no servidor (`apps/server/.env`, fora do git). Logs sem conteúdo da conversa.
- `utteranceId` = `${channel}-${n}`. O painel guarda no máximo **200 falas**.
- Textos da interface em português do Brasil.

## Review Focus

1. Participante fala sem pausa por muito tempo → a tradução sai a cada frase, ou a cada 2,5 s / 30 palavras, sem esperar o fim da fala (testes na Task 3).
2. Deepgram recusa a chave ou cai no meio da sessão → a captura continua, a fala aberta fecha como interrompida e o painel avisa "A transcrição parou" (testes nas Tasks 4 e 6).
3. DeepL fora do ar, lento ou sem cota (HTTP 456) → a frase fica só em inglês com aviso; nada trava (testes nas Tasks 5 e 6).
4. Usuário clica Parar no meio de uma frase → as últimas palavras são finalizadas e traduzidas antes de `session.ended` (teste na Task 6).
5. Sessão longa com centenas de falas → o painel mantém só as 200 mais recentes e continua fluido (teste na Task 7).

---

## Estrutura de arquivos

```
packages/shared/src/messages.ts            + eventos transcript.segment, utterance.end, translation, translation.error, error

apps/server/src/
  stt/types.ts                             SttResult ampliado; SttCallbacks; finalize()
  stt/deepgram-messages.ts (+test)         JSON do Deepgram → SttResult (puro)
  stt/deepgram-stt.ts (+test)              cliente WebSocket do Deepgram
  stt/fake-stt.ts (+test)                  adaptado à nova interface
  utterance-assembler.ts (+test)           parcial/segmento/fim de fala (puro)
  sentence-splitter.ts (+test)             quando uma frase está pronta (puro, timers)
  translate/translator.ts (+test)          interface Translator + translateWithRetry
  translate/deepl-translator.ts (+test)    cliente HTTP do DeepL
  translate/fake-translator.ts             tradução falsa para desenvolvimento
  latency.ts (+test)                       p50/p95
  channel-pipeline.ts                      por canal: sequência, STT, montagem, tradução
  session.ts                               dois pipelines + seq dos eventos + drain
  gateway.ts                               Parar espera o drain
  config.ts (+test)                        chaves dos provedores
  providers.ts (+test)                     escolhe provedores reais ou falsos
  main.ts
  test-support/scripted-stt.ts             STT controlado pelos testes
  test-support/wait.ts                     waitUntil
  session-transcription.test.ts            integração ponta a ponta com STT/tradução roteirizados

apps/extension/src/
  offscreen/session-store.ts (+test)       captions (falas) no estado
  sidepanel/caption-view.ts (+test)        texto exibido de cada fala (puro)
  offscreen/coalesce.ts (+test)            agrupa broadcasts do estado (50 ms)
  offscreen/main.ts                        usa coalesce
  sidepanel.html, sidepanel/main.ts, sidepanel/sidepanel.css   legenda
README.md                                  chaves e roteiro dos marcos 3–4
```

---

### Task 1: Eventos de transcrição e tradução no protocolo

**Files:**
- Modify: `packages/shared/src/messages.ts`, `packages/shared/src/messages.test.ts`
- Modify (compatibilidade temporária até a Task 6): `apps/server/src/session.ts`

**Interfaces:**
- Produces (em `@snowspeak/shared`): `ERROR_SCOPES`; corpos de evento
  - `{ type: "transcript.partial"; channel; utteranceId: string; text }`
  - `{ type: "transcript.segment"; channel; utteranceId; segmentIdx: number; text }`
  - `{ type: "utterance.end"; channel; utteranceId; interrupted: boolean }`
  - `{ type: "translation"; channel; utteranceId; sentenceIdx: number; source: string; text: string }`
  - `{ type: "translation.error"; channel; utteranceId; sentenceIdx }`
  - `{ type: "audio.gap"; … }` (inalterado)
  - `{ type: "error"; scope: "stt" | "translate" | "suggest" | "session"; code: string; retryable: boolean; message: string; channel?: Channel }`
  - `EventEnvelope` perde `utteranceId` (agora faz parte dos corpos que o exigem) e mantém `channel` fora do envelope.

- [ ] **Step 1: Escrever os testes novos**

Em `packages/shared/src/messages.test.ts`, trocar o evento parcial usado em `distingue eventos` por um com `utteranceId: "them-1"`, e acrescentar ao `describe("mensagens do servidor")`:

```ts
  it("aceita os eventos de transcrição e tradução", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, channel: "them", utteranceId: "them-1" };
    const events = [
      { ...base, type: "transcript.partial", text: "hel" },
      { ...base, type: "transcript.segment", segmentIdx: 0, text: "Hello." },
      { ...base, type: "utterance.end", interrupted: false },
      { ...base, type: "translation", sentenceIdx: 0, source: "Hello.", text: "Olá." },
      { ...base, type: "translation.error", sentenceIdx: 1 },
    ];
    for (const event of events) expect(parseServerMessage(JSON.stringify(event))).toEqual(event);
  });

  it("aceita evento de erro com e sem canal", () => {
    const error = { v: 1, sessionId: "s", seq: 2, ts: 0, type: "error", scope: "stt", code: "stt_connection_lost", retryable: false, message: "caiu" };
    expect(parseServerMessage(JSON.stringify(error))).toEqual(error);
    expect(parseServerMessage(JSON.stringify({ ...error, channel: "me" }))).toEqual({ ...error, channel: "me" });
    expect(parseServerMessage(JSON.stringify({ ...error, scope: "universe" }))).toBeNull();
  });

  it("rejeita eventos de fala sem utteranceId ou com índice inválido", () => {
    const base = { v: 1, sessionId: "s", seq: 1, ts: 0, channel: "them" };
    expect(parseServerMessage(JSON.stringify({ ...base, type: "transcript.partial", text: "x" }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...base, utteranceId: "them-1", type: "transcript.segment", segmentIdx: -1, text: "x" }))).toBeNull();
    expect(
      parseServerMessage(JSON.stringify({ ...base, utteranceId: "them-1", type: "translation", sentenceIdx: 0.5, source: "a", text: "b" })),
    ).toBeNull();
  });
```

No teste existente `rejeita evento sem seq, com seq inválido ou canal desconhecido`, acrescentar `utteranceId: "them-1"` ao objeto `partial`.

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test packages/shared/src/messages.test.ts`
Expected: FAIL nos três testes novos (tipos de evento desconhecidos).

- [ ] **Step 3: Implementar**

Em `packages/shared/src/messages.ts`, substituir o bloco de eventos (de `// Eventos: envelope com seq monotônico.` até o fim do arquivo) por:

```ts
export const ERROR_SCOPES = ["stt", "translate", "suggest", "session"] as const;
export type ErrorScope = (typeof ERROR_SCOPES)[number];

// Eventos: envelope com seq monotônico.
const envelopeShape = {
  v: z.literal(1),
  sessionId: z.string().min(1),
  seq: z.number().int().min(1),
  ts: z.number(),
};

const utteranceIdSchema = z.string().min(1);
const indexSchema = z.number().int().min(0);

const transcriptPartialBody = z.object({
  type: z.literal("transcript.partial"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  text: z.string(),
});

const transcriptSegmentBody = z.object({
  type: z.literal("transcript.segment"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  segmentIdx: indexSchema,
  text: z.string(),
});

const utteranceEndBody = z.object({
  type: z.literal("utterance.end"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  interrupted: z.boolean(),
});

const translationBody = z.object({
  type: z.literal("translation"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  sentenceIdx: indexSchema,
  source: z.string(),
  text: z.string(),
});

const translationErrorBody = z.object({
  type: z.literal("translation.error"),
  channel: channelSchema,
  utteranceId: utteranceIdSchema,
  sentenceIdx: indexSchema,
});

const audioGapBody = z.object({
  type: z.literal("audio.gap"),
  channel: channelSchema,
  durationMs: z.number().nonnegative(),
  reason: z.enum(AUDIO_GAP_REASONS),
});

const errorBody = z.object({
  type: z.literal("error"),
  scope: z.enum(ERROR_SCOPES),
  code: z.string().min(1),
  retryable: z.boolean(),
  message: z.string(),
  channel: channelSchema.optional(),
});

const serverMessageSchema = z.discriminatedUnion("type", [
  sessionStartedSchema,
  sessionEndedSchema,
  transcriptPartialBody.extend(envelopeShape),
  transcriptSegmentBody.extend(envelopeShape),
  utteranceEndBody.extend(envelopeShape),
  translationBody.extend(envelopeShape),
  translationErrorBody.extend(envelopeShape),
  audioGapBody.extend(envelopeShape),
  errorBody.extend(envelopeShape),
]);

export type ServerControl = z.infer<typeof sessionStartedSchema> | z.infer<typeof sessionEndedSchema>;

export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
}

export type ServerEventBody =
  | z.infer<typeof transcriptPartialBody>
  | z.infer<typeof transcriptSegmentBody>
  | z.infer<typeof utteranceEndBody>
  | z.infer<typeof translationBody>
  | z.infer<typeof translationErrorBody>
  | z.infer<typeof audioGapBody>
  | z.infer<typeof errorBody>;

export type ServerEvent = EventEnvelope & ServerEventBody;

export type ServerMessage = ServerControl | ServerEvent;

export function isServerEvent(message: ServerMessage): message is ServerEvent {
  return "seq" in message;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const result = serverMessageSchema.safeParse(parseJson(raw));
  return result.success ? result.data : null;
}
```

Compatibilidade temporária em `apps/server/src/session.ts` (substituída na Task 6): em `onSttResult`, emitir `{ type: "transcript.partial", channel, utteranceId: \`${channel}-1\`, text: result.text }`.

- [ ] **Step 4: Rodar testes e typecheck**

Run: `pnpm test packages/shared && pnpm -r typecheck`
Expected: PASS e typecheck sem erros nos três pacotes.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/server/src/session.ts
git commit -m "feat(shared): eventos de transcrição, tradução e erro no protocolo"
```

---

### Task 2: Mensagens do Deepgram e montagem das falas

**Files:**
- Modify: `apps/server/src/stt/types.ts`, `apps/server/src/stt/fake-stt.ts`, `apps/server/src/stt/fake-stt.test.ts`, `apps/server/src/session.ts`
- Create: `apps/server/src/stt/deepgram-messages.ts`, `apps/server/src/utterance-assembler.ts`
- Test: `apps/server/src/stt/deepgram-messages.test.ts`, `apps/server/src/utterance-assembler.test.ts`

**Interfaces:**
- Produces:
  - `type SttResult = { kind: "partial"; text } | { kind: "segment"; text; start: number; end: number; speechFinal: boolean; fromFinalize: boolean } | { kind: "utteranceEnd"; lastWordEnd: number }` (tempos em segundos desde o início do stream)
  - `interface SttCallbacks { onResult(result: SttResult): void; onError(error: Error): void }`
  - `interface SttStream { write(pcm: Uint8Array): void; finalize(): void; close(): void }`
  - `type SttFactory = (channel: Channel, callbacks: SttCallbacks) => SttStream`
  - `parseDeepgramMessage(raw: string): SttResult | null`
  - `type AssemblerOutput = { type: "transcript.partial"; utteranceId; text } | { type: "transcript.segment"; utteranceId; segmentIdx; text } | { type: "utterance.end"; utteranceId; interrupted }`
  - `class UtteranceAssembler { constructor(channel); readonly hasOpenUtterance: boolean; push(result: SttResult): AssemblerOutput[]; forceClose(): AssemblerOutput[] }`

- [ ] **Step 1: Escrever os testes**

Criar `apps/server/src/stt/deepgram-messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseDeepgramMessage } from "./deepgram-messages";

function results(overrides: Record<string, unknown>, alternative: Record<string, unknown>): string {
  return JSON.stringify({ type: "Results", start: 1.5, duration: 1, channel: { alternatives: [alternative] }, ...overrides });
}

describe("parseDeepgramMessage", () => {
  it("resultado provisório vira parcial; provisório vazio é ignorado", () => {
    expect(parseDeepgramMessage(results({ is_final: false }, { transcript: " hello the " }))).toEqual({ kind: "partial", text: "hello the" });
    expect(parseDeepgramMessage(results({ is_final: false }, { transcript: "" }))).toBeNull();
  });

  it("resultado final vira segmento com os tempos das palavras", () => {
    const raw = results(
      { is_final: true, speech_final: true },
      { transcript: "Hello there.", words: [{ word: "hello", start: 1.6, end: 1.9 }, { word: "there", start: 2, end: 2.3 }] },
    );
    expect(parseDeepgramMessage(raw)).toEqual({ kind: "segment", text: "Hello there.", start: 1.6, end: 2.3, speechFinal: true, fromFinalize: false });
  });

  it("sem palavras usa start e duration do resultado; marca from_finalize", () => {
    const raw = results({ is_final: true, from_finalize: true }, { transcript: "" });
    expect(parseDeepgramMessage(raw)).toEqual({ kind: "segment", text: "", start: 1.5, end: 2.5, speechFinal: false, fromFinalize: true });
  });

  it("UtteranceEnd informa o fim da última palavra", () => {
    expect(parseDeepgramMessage('{"type":"UtteranceEnd","channel":[0,1],"last_word_end":2.3}')).toEqual({ kind: "utteranceEnd", lastWordEnd: 2.3 });
  });

  it("ignora outros tipos, formatos inesperados e JSON inválido", () => {
    expect(parseDeepgramMessage('{"type":"SpeechStarted","channel":[0],"timestamp":1}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"Metadata"}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"Results","is_final":true,"channel":{}}')).toBeNull();
    expect(parseDeepgramMessage('{"type":"UtteranceEnd"}')).toBeNull();
    expect(parseDeepgramMessage("nope")).toBeNull();
  });
});
```

Criar `apps/server/src/utterance-assembler.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SttResult } from "./stt/types";
import { UtteranceAssembler } from "./utterance-assembler";

const partial = (text: string): SttResult => ({ kind: "partial", text });
const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});
const utteranceEnd = (lastWordEnd: number): SttResult => ({ kind: "utteranceEnd", lastWordEnd });

describe("UtteranceAssembler", () => {
  it("parciais abrem a fala e mantêm o mesmo id", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(partial("hel"))).toEqual([{ type: "transcript.partial", utteranceId: "them-1", text: "hel" }]);
    expect(a.push(partial("hello"))).toEqual([{ type: "transcript.partial", utteranceId: "them-1", text: "hello" }]);
    expect(a.hasOpenUtterance).toBe(true);
  });

  it("numera os segmentos estáveis e fecha no speech_final", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(segment("Hello", 0.1, 0.5))).toEqual([{ type: "transcript.segment", utteranceId: "them-1", segmentIdx: 0, text: "Hello" }]);
    expect(a.push(segment("there.", 0.6, 0.9, { speechFinal: true }))).toEqual([
      { type: "transcript.segment", utteranceId: "them-1", segmentIdx: 1, text: "there." },
      { type: "utterance.end", utteranceId: "them-1", interrupted: false },
    ]);
    expect(a.hasOpenUtterance).toBe(false);
  });

  it("a fala seguinte recebe um novo id", () => {
    const a = new UtteranceAssembler("me");
    a.push(segment("Oi.", 0, 0.4, { speechFinal: true }));
    expect(a.push(partial("tudo"))).toEqual([{ type: "transcript.partial", utteranceId: "me-2", text: "tudo" }]);
  });

  it("UtteranceEnd fecha a fala quando o speech_final não veio", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("So basically", 1, 1.8));
    expect(a.push(utteranceEnd(1.8))).toEqual([{ type: "utterance.end", utteranceId: "them-1", interrupted: false }]);
  });

  it("speech_final e UtteranceEnd da mesma fala geram um único utterance.end", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("Yes.", 1, 1.3, { speechFinal: true }));
    expect(a.push(utteranceEnd(1.3))).toEqual([]);
  });

  it("UtteranceEnd atrasado da fala anterior não fecha a fala nova", () => {
    const a = new UtteranceAssembler("them");
    a.push(segment("First one.", 1, 1.6, { speechFinal: true }));
    a.push(segment("And then", 3, 3.4));
    expect(a.push(utteranceEnd(1.6))).toEqual([]);
    expect(a.hasOpenUtterance).toBe(true);
    expect(a.push(utteranceEnd(3.4))).toEqual([{ type: "utterance.end", utteranceId: "them-2", interrupted: false }]);
  });

  it("segmento vindo do Finalize encerra a fala sem marcar interrompida", () => {
    const a = new UtteranceAssembler("them");
    a.push(partial("almost do"));
    expect(a.push(segment("almost done", 0, 0.8, { fromFinalize: true }))).toEqual([
      { type: "transcript.segment", utteranceId: "them-1", segmentIdx: 0, text: "almost done" },
      { type: "utterance.end", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("forceClose fecha como interrompida e não emite nada sem fala aberta", () => {
    const a = new UtteranceAssembler("them");
    expect(a.forceClose()).toEqual([]);
    a.push(partial("wait"));
    expect(a.forceClose()).toEqual([{ type: "utterance.end", utteranceId: "them-1", interrupted: true }]);
    expect(a.hasOpenUtterance).toBe(false);
  });

  it("final vazio sem fala aberta não emite nada", () => {
    const a = new UtteranceAssembler("them");
    expect(a.push(segment("", 0, 1, { speechFinal: true }))).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/stt/deepgram-messages.test.ts apps/server/src/utterance-assembler.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar**

Substituir `apps/server/src/stt/types.ts`:

```ts
import type { Channel } from "@snowspeak/shared";

/** Tempos em segundos desde o início do stream do provedor. */
export type SttResult =
  | { kind: "partial"; text: string }
  | { kind: "segment"; text: string; start: number; end: number; speechFinal: boolean; fromFinalize: boolean }
  | { kind: "utteranceEnd"; lastWordEnd: number };

export interface SttCallbacks {
  onResult(result: SttResult): void;
  /** A conexão com o provedor caiu ou foi recusada (nunca chamado depois de close()). */
  onError(error: Error): void;
}

export interface SttStream {
  write(pcm: Uint8Array): void;
  /** Pede ao provedor que entregue já o que tem pendente. */
  finalize(): void;
  close(): void;
}

export type SttFactory = (channel: Channel, callbacks: SttCallbacks) => SttStream;
```

Criar `apps/server/src/stt/deepgram-messages.ts`:

```ts
import type { SttResult } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

/** Converte uma mensagem do WebSocket do Deepgram; devolve null para o que não interessa. */
export function parseDeepgramMessage(raw: string): SttResult | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;

  if (data.type === "UtteranceEnd") {
    return typeof data.last_word_end === "number" ? { kind: "utteranceEnd", lastWordEnd: data.last_word_end } : null;
  }
  if (data.type !== "Results") return null;

  const channel = isRecord(data.channel) ? data.channel : null;
  const alternatives = channel && Array.isArray(channel.alternatives) ? channel.alternatives : [];
  const alternative = isRecord(alternatives[0]) ? alternatives[0] : null;
  if (!alternative) return null;

  const text = typeof alternative.transcript === "string" ? alternative.transcript.trim() : "";
  if (data.is_final !== true) return text ? { kind: "partial", text } : null;

  const words = Array.isArray(alternative.words) ? alternative.words.filter(isRecord) : [];
  const resultStart = numberOr(data.start, 0);
  const resultEnd = resultStart + numberOr(data.duration, 0);
  return {
    kind: "segment",
    text,
    start: numberOr(words[0]?.start, resultStart),
    end: numberOr(words[words.length - 1]?.end, resultEnd),
    speechFinal: data.speech_final === true,
    fromFinalize: data.from_finalize === true,
  };
}
```

Criar `apps/server/src/utterance-assembler.ts`:

```ts
import type { Channel } from "@snowspeak/shared";
import type { SttResult } from "./stt/types";

export type AssemblerOutput =
  | { type: "transcript.partial"; utteranceId: string; text: string }
  | { type: "transcript.segment"; utteranceId: string; segmentIdx: number; text: string }
  | { type: "utterance.end"; utteranceId: string; interrupted: boolean };

interface OpenUtterance {
  id: string;
  firstWordStart: number | null;
  segments: number;
}

// Uma fala por vez por canal. Parcial nunca vira segmento; o fim é emitido uma única vez.
export class UtteranceAssembler {
  private count = 0;
  private current: OpenUtterance | null = null;

  constructor(private readonly channel: Channel) {}

  get hasOpenUtterance(): boolean {
    return this.current !== null;
  }

  push(result: SttResult): AssemblerOutput[] {
    switch (result.kind) {
      case "partial":
        return [{ type: "transcript.partial", utteranceId: this.open().id, text: result.text }];
      case "segment": {
        const outputs: AssemblerOutput[] = [];
        if (result.text) {
          const utterance = this.open();
          utterance.firstWordStart ??= result.start;
          outputs.push({ type: "transcript.segment", utteranceId: utterance.id, segmentIdx: utterance.segments, text: result.text });
          utterance.segments += 1;
        }
        if ((result.speechFinal || result.fromFinalize) && this.current) outputs.push(this.close(false));
        return outputs;
      }
      case "utteranceEnd": {
        const utterance = this.current;
        if (!utterance) return [];
        // UtteranceEnd atrasado de uma fala já encerrada: nunca fecha a fala nova.
        if (utterance.firstWordStart !== null && result.lastWordEnd < utterance.firstWordStart) return [];
        return [this.close(false)];
      }
    }
  }

  forceClose(): AssemblerOutput[] {
    return this.current ? [this.close(true)] : [];
  }

  private open(): OpenUtterance {
    if (!this.current) {
      this.count += 1;
      this.current = { id: `${this.channel}-${this.count}`, firstWordStart: null, segments: 0 };
    }
    return this.current;
  }

  /** Só é chamado com uma fala aberta. */
  private close(interrupted: boolean): AssemblerOutput {
    const id = this.current?.id ?? "";
    this.current = null;
    return { type: "utterance.end", utteranceId: id, interrupted };
  }
}
```

Adaptar `apps/server/src/stt/fake-stt.ts` à nova interface (a fábrica recebe `callbacks` e o stream ganha `finalize`):

```ts
import { SAMPLE_RATE } from "@snowspeak/shared";
import { SignalProbe, describeSignal } from "./signal-probe";
import type { SttFactory } from "./types";

// STT falso guiado pelo próprio áudio: usado sem DEEPGRAM_API_KEY e nos testes do marco 1.
export function createFakeSttFactory(options: { reportEveryMs?: number } = {}): SttFactory {
  const reportEverySamples = ((options.reportEveryMs ?? 1_000) * SAMPLE_RATE) / 1_000;

  return (channel, callbacks) => {
    const probe = new SignalProbe();
    let samples = 0;
    let lastReported = 0;
    let closed = false;

    return {
      write(pcm) {
        if (closed) return;
        probe.add(pcm);
        samples += pcm.byteLength / 2;
        if (samples - lastReported >= reportEverySamples) {
          lastReported = samples;
          callbacks.onResult({ kind: "partial", text: describeSignal(channel, samples / SAMPLE_RATE, probe.takeReport()) });
        }
      },
      finalize() {},
      close() {
        closed = true;
      },
    };
  };
}
```

Em `apps/server/src/stt/fake-stt.test.ts`, trocar as duas chamadas `createFakeSttFactory(...)("them", (r) => results.push(r))` por `createFakeSttFactory(...)("them", { onResult: (r) => results.push(r), onError: () => {} })` (e o mesmo para `"me"`).

Em `apps/server/src/session.ts` (compatível até a Task 6): a fábrica passa a receber `{ onResult: (result) => this.onSttResult(channel, result), onError: () => {} }`, e `onSttResult` só emite quando `result.kind === "partial"`.

- [ ] **Step 4: Rodar testes e typecheck**

Run: `pnpm test apps/server && pnpm --filter @snowspeak/server typecheck`
Expected: PASS em todos os testes do servidor e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): interpretação das mensagens do Deepgram e montagem das falas"
```

---

### Task 3: Divisão em frases para tradução

**Files:**
- Create: `apps/server/src/sentence-splitter.ts`
- Test: `apps/server/src/sentence-splitter.test.ts`

**Interfaces:**
- Produces: `SENTENCE_MAX_WAIT_MS = 2500`, `SENTENCE_MAX_WORDS = 30`, `interface SentenceReady { utteranceId: string; sentenceIdx: number; text: string }`, `class SentenceSplitter { constructor(onSentence: (s: SentenceReady) => void); addSegment(utteranceId: string, text: string): void; endUtterance(utteranceId: string): void; dispose(): void }`

- [ ] **Step 1: Escrever os testes**

Criar `apps/server/src/sentence-splitter.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SENTENCE_MAX_WAIT_MS, SentenceSplitter, type SentenceReady } from "./sentence-splitter";

function setup() {
  const sentences: SentenceReady[] = [];
  const splitter = new SentenceSplitter((s) => sentences.push(s));
  return { splitter, sentences, texts: () => sentences.map((s) => s.text) };
}

describe("SentenceSplitter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("envia a frase assim que ela termina com pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Hello there.");
    expect(t.sentences).toEqual([{ utteranceId: "them-1", sentenceIdx: 0, text: "Hello there." }]);
  });

  it("junta segmentos até a pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "How are");
    expect(t.sentences).toEqual([]);
    t.splitter.addSegment("them-1", "you today?");
    expect(t.texts()).toEqual(["How are you today?"]);
  });

  it("separa o que já terminou do resto e numera em ordem", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Great. I think");
    expect(t.texts()).toEqual(["Great."]);
    t.splitter.addSegment("them-1", "we should start. Then");
    expect(t.sentences.map((s) => [s.sentenceIdx, s.text])).toEqual([
      [0, "Great."],
      [1, "I think we should start."],
    ]);
  });

  it("não corta números decimais nem pontuação no meio de palavras", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "It costs 3.5 dollars at example.com today");
    expect(t.sentences).toEqual([]);
  });

  it("envia depois de 2,5 s sem pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "so basically what we");
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS - 1);
    expect(t.sentences).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(t.texts()).toEqual(["so basically what we"]);
  });

  it("o prazo conta a partir do trecho que ficou pendente", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "no pause");
    vi.advanceTimersByTime(2_000);
    t.splitter.addSegment("them-1", "at all. and more");
    vi.advanceTimersByTime(2_000);
    expect(t.texts()).toEqual(["no pause at all."]);
    vi.advanceTimersByTime(500);
    expect(t.texts()).toEqual(["no pause at all.", "and more"]);
  });

  it("envia ao atingir 30 palavras mesmo sem pausa nem pontuação", () => {
    const t = setup();
    t.splitter.addSegment("them-1", Array.from({ length: 29 }, (_, i) => `w${i}`).join(" "));
    expect(t.sentences).toEqual([]);
    t.splitter.addSegment("them-1", "w29");
    expect(t.sentences).toHaveLength(1);
    expect(t.sentences[0]?.text.split(" ")).toHaveLength(30);
  });

  it("fim da fala envia o restante e a próxima fala recomeça do índice 0", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "Hi.");
    t.splitter.addSegment("them-1", "there");
    t.splitter.endUtterance("them-1");
    t.splitter.addSegment("them-2", "Next.");
    expect(t.sentences).toEqual([
      { utteranceId: "them-1", sentenceIdx: 0, text: "Hi." },
      { utteranceId: "them-1", sentenceIdx: 1, text: "there" },
      { utteranceId: "them-2", sentenceIdx: 0, text: "Next." },
    ]);
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS);
    expect(t.sentences).toHaveLength(3);
  });

  it("segmento de outra fala envia o pendente da anterior", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "unfinished");
    t.splitter.addSegment("them-2", "Other.");
    expect(t.sentences.map((s) => [s.utteranceId, s.text])).toEqual([
      ["them-1", "unfinished"],
      ["them-2", "Other."],
    ]);
  });

  it("dispose descarta o pendente e cancela o prazo", () => {
    const t = setup();
    t.splitter.addSegment("them-1", "pending words");
    t.splitter.dispose();
    vi.advanceTimersByTime(SENTENCE_MAX_WAIT_MS);
    expect(t.sentences).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/sentence-splitter.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar**

Criar `apps/server/src/sentence-splitter.ts`:

```ts
export const SENTENCE_MAX_WAIT_MS = 2_500;
export const SENTENCE_MAX_WORDS = 30;

export interface SentenceReady {
  utteranceId: string;
  sentenceIdx: number;
  text: string;
}

// Fim de frase: . ? ! (e aspas/parênteses de fechamento) seguido de espaço ou do fim do texto.
const SENTENCE_END = /[.?!]+["')\]]*(?=\s|$)/g;

function splitComplete(text: string): { complete: string; rest: string } {
  let cut = -1;
  for (const match of text.matchAll(SENTENCE_END)) cut = match.index + match[0].length;
  if (cut < 0) return { complete: "", rest: text };
  return { complete: text.slice(0, cut).trim(), rest: text.slice(cut).trim() };
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// Decide quando um trecho do canal them está pronto para tradução, sem esperar o fim de falas longas.
export class SentenceSplitter {
  private utteranceId: string | null = null;
  private pending = "";
  private nextIdx = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly onSentence: (sentence: SentenceReady) => void) {}

  addSegment(utteranceId: string, text: string): void {
    if (this.utteranceId !== utteranceId) {
      this.flush();
      this.utteranceId = utteranceId;
      this.nextIdx = 0;
    }
    this.pending = this.pending ? `${this.pending} ${text}` : text;

    const { complete, rest } = splitComplete(this.pending);
    if (complete) {
      this.pending = rest;
      this.clearTimer();
      this.emit(complete);
    }
    if (!this.pending) return;
    if (wordCount(this.pending) >= SENTENCE_MAX_WORDS) {
      this.flush();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      this.flush();
    }, SENTENCE_MAX_WAIT_MS);
  }

  endUtterance(utteranceId: string): void {
    if (this.utteranceId !== utteranceId) return;
    this.flush();
    this.utteranceId = null;
  }

  dispose(): void {
    this.clearTimer();
    this.pending = "";
  }

  private flush(): void {
    this.clearTimer();
    const text = this.pending.trim();
    this.pending = "";
    if (text) this.emit(text);
  }

  private emit(text: string): void {
    if (this.utteranceId === null) return;
    this.onSentence({ utteranceId: this.utteranceId, sentenceIdx: this.nextIdx, text });
    this.nextIdx += 1;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm test apps/server/src/sentence-splitter.test.ts && pnpm --filter @snowspeak/server typecheck`
Expected: PASS (10 testes) e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sentence-splitter.ts apps/server/src/sentence-splitter.test.ts
git commit -m "feat(server): divisão em frases para tradução com prazo e limite de palavras"
```

---

### Task 4: Cliente do Deepgram

**Files:**
- Create: `apps/server/src/stt/deepgram-stt.ts`, `apps/server/src/test-support/wait.ts`
- Test: `apps/server/src/stt/deepgram-stt.test.ts`

**Interfaces:**
- Consumes: `SttFactory`, `SttCallbacks` (Task 2), `parseDeepgramMessage` (Task 2).
- Produces: `DEEPGRAM_URL`, `deepgramListenUrl(baseUrl: string, channel: Channel): string`, `createDeepgramSttFactory(options: { apiKey: string; baseUrl?: string }): SttFactory`; `waitUntil(check: () => boolean, timeoutMs?: number): Promise<void>`.

- [ ] **Step 1: Escrever os testes (com um servidor WebSocket local no lugar do Deepgram)**

Criar `apps/server/src/test-support/wait.ts`:

```ts
export async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condição não atingida no prazo");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
```

Criar `apps/server/src/stt/deepgram-stt.test.ts`:

```ts
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { waitUntil } from "../test-support/wait";
import { createDeepgramSttFactory } from "./deepgram-stt";
import type { SttResult } from "./types";

interface FakeDeepgram {
  server: WebSocketServer;
  url: string;
  connections: Array<{ socket: WebSocket; request: IncomingMessage; received: Array<Buffer | string> }>;
}

async function startFakeDeepgram(options: { reject?: boolean } = {}): Promise<FakeDeepgram> {
  const server = new WebSocketServer({ port: 0, verifyClient: () => !options.reject });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const fake: FakeDeepgram = { server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/v1/listen`, connections: [] };
  server.on("connection", (socket, request) => {
    const entry = { socket, request, received: [] as Array<Buffer | string> };
    socket.on("message", (data, isBinary) => entry.received.push(isBinary ? (data as Buffer) : data.toString()));
    fake.connections.push(entry);
  });
  return fake;
}

function collect() {
  const results: SttResult[] = [];
  const errors: Error[] = [];
  return { results, errors, callbacks: { onResult: (r: SttResult) => results.push(r), onError: (e: Error) => errors.push(e) } };
}

describe("DeepgramStt", () => {
  let fake: FakeDeepgram;

  beforeEach(async () => {
    fake = await startFakeDeepgram();
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it("conecta com a chave e os parâmetros de cada canal", async () => {
    const factory = createDeepgramSttFactory({ apiKey: "test-key", baseUrl: fake.url });
    factory("them", collect().callbacks);
    factory("me", collect().callbacks);
    await waitUntil(() => fake.connections.length === 2);

    const [them, me] = fake.connections.map((c) => new URL(c.request.url ?? "", "http://x").searchParams);
    expect(fake.connections[0]?.request.headers.authorization).toBe("Token test-key");
    expect(Object.fromEntries(them!)).toMatchObject({
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
    expect(me!.get("language")).toBe("multi");
  });

  it("envia o áudio como binário, inclusive o que chegou antes de a conexão abrir", async () => {
    const stream = createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", collect().callbacks);
    stream.write(new Uint8Array([1, 2]));
    await waitUntil(() => fake.connections.length === 1);
    stream.write(new Uint8Array([3, 4]));
    const connection = fake.connections[0]!;
    await waitUntil(() => connection.received.length === 2);
    expect(connection.received.map((m) => Array.from(m as Buffer))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("entrega os resultados interpretados", async () => {
    const c = collect();
    createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    fake.connections[0]!.socket.send(
      JSON.stringify({ type: "Results", is_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: "hello" }] } }),
    );
    await waitUntil(() => c.results.length === 1);
    expect(c.results).toEqual([{ kind: "partial", text: "hello" }]);
  });

  it("envia Finalize e, ao fechar, CloseStream sem reportar erro", async () => {
    const c = collect();
    const stream = createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    const connection = fake.connections[0]!;
    await waitUntil(() => connection.socket.readyState === connection.socket.OPEN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.finalize();
    stream.close();
    await waitUntil(() => connection.received.length === 2);
    expect(connection.received).toEqual(['{"type":"Finalize"}', '{"type":"CloseStream"}']);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.errors).toEqual([]);
  });

  it("avisa uma única vez quando a conexão cai", async () => {
    const c = collect();
    createDeepgramSttFactory({ apiKey: "k", baseUrl: fake.url })("them", c.callbacks);
    await waitUntil(() => fake.connections.length === 1);
    fake.connections[0]!.socket.terminate();
    await waitUntil(() => c.errors.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(c.errors).toHaveLength(1);
  });

  it("avisa quando a chave é recusada", async () => {
    const rejecting = await startFakeDeepgram({ reject: true });
    const c = collect();
    createDeepgramSttFactory({ apiKey: "errada", baseUrl: rejecting.url })("them", c.callbacks);
    await waitUntil(() => c.errors.length > 0);
    expect(c.errors[0]?.message).toContain("401");
    await new Promise<void>((resolve) => rejecting.server.close(() => resolve()));
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/stt/deepgram-stt.test.ts`
Expected: FAIL — `./deepgram-stt` inexistente.

- [ ] **Step 3: Implementar**

Criar `apps/server/src/stt/deepgram-stt.ts`:

```ts
import WebSocket from "ws";
import type { Channel } from "@snowspeak/shared";
import { parseDeepgramMessage } from "./deepgram-messages";
import type { SttFactory } from "./types";

export const DEEPGRAM_URL = "wss://api.deepgram.com/v1/listen";
const MAX_PENDING_FRAMES = 10; // até 1 s de áudio enquanto a conexão abre

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

export function createDeepgramSttFactory(options: { apiKey: string; baseUrl?: string }): SttFactory {
  const baseUrl = options.baseUrl ?? DEEPGRAM_URL;

  return (channel, callbacks) => {
    const ws = new WebSocket(deepgramListenUrl(baseUrl, channel), { headers: { Authorization: `Token ${options.apiKey}` } });
    const pending: Uint8Array[] = [];
    let closedByUs = false;
    let failed = false;

    const fail = (reason: string): void => {
      if (closedByUs || failed) return;
      failed = true;
      callbacks.onError(new Error(reason));
    };

    ws.on("open", () => {
      for (const pcm of pending.splice(0)) ws.send(pcm);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const result = parseDeepgramMessage(data.toString());
      if (result) callbacks.onResult(result);
    });
    ws.on("error", (error) => fail(`Deepgram: ${error.message}`));
    ws.on("close", (code) => fail(`Deepgram encerrou a conexão (código ${code})`));

    return {
      write(pcm) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(pcm);
        } else if (ws.readyState === WebSocket.CONNECTING) {
          pending.push(pcm);
          if (pending.length > MAX_PENDING_FRAMES) pending.shift();
        }
      },
      finalize() {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "Finalize" }));
      },
      close() {
        closedByUs = true;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "CloseStream" }));
          ws.close(1000);
        } else {
          ws.terminate();
        }
      },
    };
  };
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm test apps/server/src/stt && pnpm --filter @snowspeak/server typecheck`
Expected: PASS e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/stt apps/server/src/test-support/wait.ts
git commit -m "feat(server): cliente de streaming do Deepgram"
```

---

### Task 5: Tradução com DeepL

**Files:**
- Create: `apps/server/src/translate/translator.ts`, `apps/server/src/translate/deepl-translator.ts`, `apps/server/src/translate/fake-translator.ts`
- Test: `apps/server/src/translate/translator.test.ts`, `apps/server/src/translate/deepl-translator.test.ts`

**Interfaces:**
- Produces:
  - `interface Translator { translate(text: string, context: string): Promise<string> }`
  - `translateWithRetry(translator: Translator, text: string, context: string): Promise<string>` (1 nova tentativa)
  - `DEEPL_TIMEOUT_MS = 5000`, `deeplBaseUrl(apiKey: string): string`, `createDeepLTranslator(options: { apiKey: string; baseUrl?: string; timeoutMs?: number }): Translator`
  - `createFakeTranslator(): Translator`

- [ ] **Step 1: Escrever os testes**

Criar `apps/server/src/translate/translator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { translateWithRetry, type Translator } from "./translator";

function translatorFailing(times: number): Translator & { calls: number } {
  const t = {
    calls: 0,
    translate: vi.fn(async (text: string) => {
      t.calls += 1;
      if (t.calls <= times) throw new Error("falhou");
      return `pt:${text}`;
    }),
  };
  return t;
}

describe("translateWithRetry", () => {
  it("devolve a tradução na primeira tentativa", async () => {
    const t = translatorFailing(0);
    await expect(translateWithRetry(t, "Hi.", "")).resolves.toBe("pt:Hi.");
    expect(t.calls).toBe(1);
  });

  it("tenta de novo uma vez", async () => {
    const t = translatorFailing(1);
    await expect(translateWithRetry(t, "Hi.", "ctx")).resolves.toBe("pt:Hi.");
    expect(t.translate).toHaveBeenLastCalledWith("Hi.", "ctx");
  });

  it("desiste depois da segunda falha", async () => {
    const t = translatorFailing(2);
    await expect(translateWithRetry(t, "Hi.", "")).rejects.toThrow("falhou");
    expect(t.calls).toBe(2);
  });
});
```

Criar `apps/server/src/translate/deepl-translator.test.ts`:

```ts
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDeepLTranslator, deeplBaseUrl } from "./deepl-translator";

interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

let server: Server | null = null;

async function startFakeDeepL(respond: (captured: Captured) => { status: number; body?: unknown; hang?: boolean }) {
  const requests: Captured[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const captured: Captured = { url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) as Record<string, unknown> };
      requests.push(captured);
      const reply = respond(captured);
      if (reply.hang) return;
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("DeepLTranslator", () => {
  it("escolhe o endereço da API pela chave", () => {
    expect(deeplBaseUrl("abc:fx")).toBe("https://api-free.deepl.com");
    expect(deeplBaseUrl("abc")).toBe("https://api.deepl.com");
  });

  it("envia texto, idiomas, modelo de baixa latência e contexto", async () => {
    const fake = await startFakeDeepL(() => ({ status: 200, body: { translations: [{ text: "Olá.", detected_source_language: "EN" }] } }));
    const translator = createDeepLTranslator({ apiKey: "key:fx", baseUrl: fake.baseUrl });
    await expect(translator.translate("Hello.", "We met yesterday.")).resolves.toBe("Olá.");
    const request = fake.requests[0]!;
    expect(request.url).toBe("/v2/translate");
    expect(request.headers.authorization).toBe("DeepL-Auth-Key key:fx");
    expect(request.body).toEqual({
      text: ["Hello."],
      source_lang: "EN",
      target_lang: "PT-BR",
      model_type: "latency_optimized",
      context: "We met yesterday.",
    });
  });

  it("não envia contexto vazio", async () => {
    const fake = await startFakeDeepL(() => ({ status: 200, body: { translations: [{ text: "Oi." }] } }));
    await createDeepLTranslator({ apiKey: "k", baseUrl: fake.baseUrl }).translate("Hi.", "");
    expect(fake.requests[0]?.body).not.toHaveProperty("context");
  });

  it("falha com o status quando a API recusa (ex.: cota esgotada)", async () => {
    const fake = await startFakeDeepL(() => ({ status: 456, body: { message: "Quota exceeded" } }));
    await expect(createDeepLTranslator({ apiKey: "k", baseUrl: fake.baseUrl }).translate("Hi.", "")).rejects.toThrow("456");
  });

  it("falha quando a resposta não traz tradução", async () => {
    const fake = await startFakeDeepL(() => ({ status: 200, body: { translations: [] } }));
    await expect(createDeepLTranslator({ apiKey: "k", baseUrl: fake.baseUrl }).translate("Hi.", "")).rejects.toThrow();
  });

  it("desiste quando a API não responde no prazo", async () => {
    const fake = await startFakeDeepL(() => ({ status: 200, hang: true }));
    await expect(createDeepLTranslator({ apiKey: "k", baseUrl: fake.baseUrl, timeoutMs: 50 }).translate("Hi.", "")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/translate`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implementar**

Criar `apps/server/src/translate/translator.ts`:

```ts
export interface Translator {
  /** `context` são frases anteriores que ajudam a tradução mas não são traduzidas. */
  translate(text: string, context: string): Promise<string>;
}

export async function translateWithRetry(translator: Translator, text: string, context: string): Promise<string> {
  try {
    return await translator.translate(text, context);
  } catch {
    return translator.translate(text, context);
  }
}
```

Criar `apps/server/src/translate/deepl-translator.ts`:

```ts
import type { Translator } from "./translator";

export const DEEPL_TIMEOUT_MS = 5_000;

export function deeplBaseUrl(apiKey: string): string {
  return apiKey.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}

export function createDeepLTranslator(options: { apiKey: string; baseUrl?: string; timeoutMs?: number }): Translator {
  const baseUrl = options.baseUrl ?? deeplBaseUrl(options.apiKey);

  return {
    async translate(text, context) {
      const body: Record<string, unknown> = {
        text: [text],
        source_lang: "EN",
        target_lang: "PT-BR",
        model_type: "latency_optimized",
      };
      if (context) body.context = context;

      const response = await fetch(`${baseUrl}/v2/translate`, {
        method: "POST",
        headers: { Authorization: `DeepL-Auth-Key ${options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEEPL_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`DeepL respondeu HTTP ${response.status}`);

      const data = (await response.json()) as { translations?: Array<{ text?: unknown }> };
      const translated = data.translations?.[0]?.text;
      if (typeof translated !== "string") throw new Error("DeepL: resposta sem tradução");
      return translated;
    },
  };
}
```

Criar `apps/server/src/translate/fake-translator.ts`:

```ts
import type { Translator } from "./translator";

// Usado sem DEEPL_API_KEY: deixa visível no painel que a tradução não é real.
export function createFakeTranslator(): Translator {
  return {
    translate: (text) => Promise.resolve(`[tradução falsa] ${text}`),
  };
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm test apps/server/src/translate && pnpm --filter @snowspeak/server typecheck`
Expected: PASS (9 testes) e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/translate
git commit -m "feat(server): tradução EN→PT-BR com DeepL e nova tentativa"
```

---

### Task 6: Pipeline por canal, sessão, gateway e provedores

**Files:**
- Create: `apps/server/src/latency.ts`, `apps/server/src/channel-pipeline.ts`, `apps/server/src/providers.ts`, `apps/server/src/test-support/scripted-stt.ts`
- Modify: `apps/server/src/session.ts`, `apps/server/src/gateway.ts`, `apps/server/src/config.ts`, `apps/server/src/main.ts`, `apps/server/.env.example`, `apps/server/src/gateway.test.ts`, `apps/server/src/config.test.ts`
- Test: `apps/server/src/latency.test.ts`, `apps/server/src/providers.test.ts`, `apps/server/src/session-transcription.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `class LatencyStats { add(ms: number): void; summary(): { count: number; p50: number | null; p95: number | null } }`, `formatLatency(label: string, stats: LatencyStats): string`
  - `FINALIZE_WAIT_MS = 500`, `TRANSLATION_DRAIN_MS = 2000`, `class ChannelPipeline { constructor(deps); acceptFrame(frame): boolean; drain(): Promise<void>; close(): void }`
  - `Session { acceptFrame(frame): boolean; drain(): Promise<void>; close(): void }` com `SessionDeps { sttFactory; translator: Translator | null; send; now? }`
  - `GatewayDeps { sttFactory: SttFactory; translator: Translator | null }`
  - `ServerConfig` + `deepgramApiKey: string | null`, `deeplApiKey: string | null`
  - `createProviders(config): { sttFactory; translator; description: string }`
  - `createScriptedSttHub(): { factory: SttFactory; channel(c: Channel): ScriptedChannel }`

- [ ] **Step 1: Escrever os testes**

Criar `apps/server/src/latency.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LatencyStats, formatLatency } from "./latency";

describe("LatencyStats", () => {
  it("calcula p50 e p95", () => {
    const stats = new LatencyStats();
    for (let ms = 1; ms <= 100; ms++) stats.add(ms);
    expect(stats.summary()).toEqual({ count: 100, p50: 50, p95: 95 });
  });

  it("ignora valores negativos ou inválidos", () => {
    const stats = new LatencyStats();
    stats.add(-5);
    stats.add(Number.NaN);
    stats.add(120);
    expect(stats.summary()).toEqual({ count: 1, p50: 120, p95: 120 });
  });

  it("formata com e sem amostras", () => {
    const stats = new LatencyStats();
    expect(formatLatency("tradução", stats)).toBe("tradução: sem amostras");
    stats.add(180.4);
    expect(formatLatency("tradução", stats)).toBe("tradução p50 180 ms · p95 180 ms (n=1)");
  });
});
```

Criar `apps/server/src/providers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { createProviders } from "./providers";

const base = { ACCESS_KEYS: "k", ALLOWED_ORIGINS: "chrome-extension://x" };

describe("createProviders", () => {
  it("usa provedores falsos quando faltam as chaves", () => {
    const providers = createProviders(loadConfig(base));
    expect(providers.description).toBe("STT: falso (sem DEEPGRAM_API_KEY) · tradução: falsa (sem DEEPL_API_KEY)");
  });

  it("usa Deepgram e DeepL quando as chaves existem", () => {
    const providers = createProviders(loadConfig({ ...base, DEEPGRAM_API_KEY: "dg", DEEPL_API_KEY: "dl:fx" }));
    expect(providers.description).toBe("STT: Deepgram · tradução: DeepL");
  });
});
```

Em `apps/server/src/config.test.ts`, acrescentar:

```ts
  it("lê as chaves dos provedores e trata vazio como ausente", () => {
    const config = loadConfig({ ACCESS_KEYS: "a", ALLOWED_ORIGINS: "o", DEEPGRAM_API_KEY: " dg ", DEEPL_API_KEY: "" });
    expect(config.deepgramApiKey).toBe("dg");
    expect(config.deeplApiKey).toBeNull();
  });
```

Criar `apps/server/src/test-support/scripted-stt.ts`:

```ts
import type { Channel } from "@snowspeak/shared";
import type { SttFactory, SttResult } from "../stt/types";

export interface ScriptedChannel {
  emit(result: SttResult): void;
  fail(): void;
  writes: number;
  finalizes: number;
  closed: boolean;
  /** Chamado quando a sessão pede Finalize; o teste decide o que o "provedor" responde. */
  onFinalize: (() => void) | null;
}

export function createScriptedSttHub(): { factory: SttFactory; channel(channel: Channel): ScriptedChannel } {
  const channels = new Map<Channel, ScriptedChannel>();
  const factory: SttFactory = (channel, callbacks) => {
    const state: ScriptedChannel = {
      emit: (result) => callbacks.onResult(result),
      fail: () => callbacks.onError(new Error("falha roteirizada")),
      writes: 0,
      finalizes: 0,
      closed: false,
      onFinalize: null,
    };
    channels.set(channel, state);
    return {
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
  };
}
```

Mover a classe `TestClient`, as constantes `ORIGIN`/`START` e a configuração de teste de `gateway.test.ts` para `apps/server/src/test-support/test-client.ts` (exportando `TestClient`, `ORIGIN`, `START` e `testConfig(overrides?: Partial<ServerConfig>): ServerConfig` com `deepgramApiKey: null, deeplApiKey: null`), acrescentando à classe:

```ts
  drop(): void {
    this.ws.terminate();
  }

  types(): string[] {
    return this.messages.map((m) => m.type);
  }
```

e fazer `gateway.test.ts` importar de lá e iniciar o gateway com `startGateway(testConfig(), { sttFactory: createFakeSttFactory(), translator: null })`.

Criar `apps/server/src/session-transcription.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import { startGateway, type Gateway } from "./gateway";
import type { SttResult } from "./stt/types";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { TestClient, testConfig } from "./test-support/test-client";
import { waitUntil } from "./test-support/wait";
import type { Translator } from "./translate/translator";

const segment = (text: string, start: number, end: number, flags: { speechFinal?: boolean; fromFinalize?: boolean } = {}): SttResult => ({
  kind: "segment",
  text,
  start,
  end,
  speechFinal: flags.speechFinal ?? false,
  fromFinalize: flags.fromFinalize ?? false,
});

function translatorFrom(impl: (text: string, context: string) => Promise<string>): Translator & { translate: ReturnType<typeof vi.fn> } {
  return { translate: vi.fn(impl) };
}

const ptTranslator = () => translatorFrom(async (text) => `pt:${text}`);

describe("transcrição e tradução de ponta a ponta", () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.close();
  });

  async function setup(translator: Translator = ptTranslator()) {
    const hub = createScriptedSttHub();
    gateway = await startGateway(testConfig(), { sttFactory: hub.factory, translator });
    const client = await TestClient.started(gateway.url);
    return { hub, client, translator };
  }

  const events = (client: TestClient, type: string) => client.messages.filter((m) => m.type === type);

  it("transmite parcial, segmentos e fim de fala com o mesmo utteranceId", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "hello" });
    them.emit(segment("Hello there.", 0, 0.8, { speechFinal: true }));
    await client.waitFor((m) => m.type === "utterance.end");
    expect(client.messages.filter((m) => m.type !== "session.started" && m.type !== "translation")).toMatchObject([
      { type: "transcript.partial", channel: "them", utteranceId: "them-1", text: "hello" },
      { type: "transcript.segment", channel: "them", utteranceId: "them-1", segmentIdx: 0, text: "Hello there." },
      { type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: false },
    ]);
  });

  it("traduz cada frase do canal them assim que ela termina", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit(segment("Hello there.", 0, 0.8));
    const translation = await client.waitFor((m) => m.type === "translation");
    expect(translation).toMatchObject({ channel: "them", utteranceId: "them-1", sentenceIdx: 0, source: "Hello there.", text: "pt:Hello there." });
  });

  it("envia as frases anteriores como contexto", async () => {
    const translator = ptTranslator();
    const { hub, client } = await setup(translator);
    const them = hub.channel("them");
    them.emit(segment("We met yesterday.", 0, 1));
    them.emit(segment("Did you like it?", 1.2, 2));
    await waitUntil(() => events(client, "translation").length === 2);
    expect(translator.translate).toHaveBeenNthCalledWith(1, "We met yesterday.", "");
    expect(translator.translate).toHaveBeenNthCalledWith(2, "Did you like it?", "We met yesterday.");
  });

  it("não traduz as falas do usuário", async () => {
    const translator = ptTranslator();
    const { hub, client } = await setup(translator);
    hub.channel("me").emit(segment("Sure, sounds good.", 0, 1, { speechFinal: true }));
    await client.waitFor((m) => m.type === "utterance.end" && m.channel === "me");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(translator.translate).not.toHaveBeenCalled();
    expect(events(client, "translation")).toEqual([]);
  });

  it("marca translation.error quando a tradução falha duas vezes", async () => {
    const translator = translatorFrom(() => Promise.reject(new Error("HTTP 456")));
    const { hub, client } = await setup(translator);
    hub.channel("them").emit(segment("Hello.", 0, 0.5));
    const error = await client.waitFor((m) => m.type === "translation.error");
    expect(error).toMatchObject({ channel: "them", utteranceId: "them-1", sentenceIdx: 0 });
    expect(translator.translate).toHaveBeenCalledTimes(2);
  });

  it("fecha a fala como interrompida e avisa quando o STT cai, sem derrubar a sessão", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "and then we" });
    them.fail();
    const error = await client.waitFor((m) => m.type === "error");
    expect(error).toMatchObject({ scope: "stt", code: "stt_connection_lost", retryable: false, channel: "them" });
    expect(events(client, "utterance.end")).toMatchObject([{ utteranceId: "them-1", interrupted: true }]);
    expect(client.ws.readyState).toBe(client.ws.OPEN);
  });

  it("ao parar, pede Finalize e entrega a fala e a tradução antes de encerrar", async () => {
    const { hub, client } = await setup();
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "almost do" });
    them.onFinalize = () => them.emit(segment("almost done", 0, 0.9, { fromFinalize: true }));
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4410);
    expect(them.finalizes).toBe(1);
    const order = client.types().filter((t) => t !== "session.started" && t !== "transcript.partial");
    expect(order).toEqual(["transcript.segment", "utterance.end", "translation", "session.ended"]);
    expect(events(client, "utterance.end")).toMatchObject([{ interrupted: false }]);
    expect(them.closed).toBe(true);
  });

  it("ao parar sem resposta do STT, fecha a fala como interrompida em até 500 ms", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit({ kind: "partial", text: "wait for" });
    const stoppedAt = Date.now();
    client.sendJson({ type: "session.stop" });
    await client.closed;
    expect(Date.now() - stoppedAt).toBeLessThan(1_500);
    expect(events(client, "utterance.end")).toMatchObject([{ utteranceId: "them-1", interrupted: true }]);
    expect(client.types().at(-1)).toBe("session.ended");
  });

  it("fecha as conexões de STT quando o socket cai", async () => {
    const { hub, client } = await setup();
    client.drop();
    await waitUntil(() => hub.channel("them").closed && hub.channel("me").closed);
  });

  it("ignora áudio e mensagens enquanto finaliza o Parar", async () => {
    const { hub, client } = await setup();
    hub.channel("them").emit({ kind: "partial", text: "slow" });
    client.sendJson({ type: "session.stop" });
    client.sendSilence("them", 0);
    const closed = await client.closed;
    expect(closed.code).toBe(4410);
    expect(hub.channel("them").writes).toBe(0);
    expect(client.messages.some((m: ServerMessage) => m.type === "session.ended")).toBe(true);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/server`
Expected: FAIL — `./latency`, `./providers` inexistentes; `session-transcription.test.ts` falha porque o gateway ainda não aceita `translator` nem emite segmentos/traduções.

- [ ] **Step 3: Implementar latência, pipeline, sessão, gateway, config e provedores**

Criar `apps/server/src/latency.ts`:

```ts
export class LatencyStats {
  private readonly samples: number[] = [];

  add(ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.samples.push(ms);
  }

  summary(): { count: number; p50: number | null; p95: number | null } {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number): number | null =>
      sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null);
    return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
  }
}

export function formatLatency(label: string, stats: LatencyStats): string {
  const { count, p50, p95 } = stats.summary();
  if (count === 0 || p50 === null || p95 === null) return `${label}: sem amostras`;
  return `${label} p50 ${Math.round(p50)} ms · p95 ${Math.round(p95)} ms (n=${count})`;
}
```

Criar `apps/server/src/channel-pipeline.ts`:

```ts
import { frameSamples, samplesToMs, type AudioFrame, type Channel, type ServerEventBody } from "@snowspeak/shared";
import { ChannelSequencer } from "./channel-sequencer";
import type { LatencyStats } from "./latency";
import { SentenceSplitter, type SentenceReady } from "./sentence-splitter";
import type { SttFactory, SttResult, SttStream } from "./stt/types";
import { translateWithRetry, type Translator } from "./translate/translator";
import { UtteranceAssembler, type AssemblerOutput } from "./utterance-assembler";

export const FINALIZE_WAIT_MS = 500;
export const TRANSLATION_DRAIN_MS = 2_000;
const CONTEXT_SENTENCES = 2;

export interface PipelineLatency {
  stt: LatencyStats;
  translation: LatencyStats;
}

export interface ChannelPipelineDeps {
  channel: Channel;
  sttFactory: SttFactory;
  /** null: canal sem tradução (me) ou tradução desligada. */
  translator: Translator | null;
  emit: (body: ServerEventBody) => void;
  latency: PipelineLatency;
  now: () => number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Um canal de áudio: continuidade dos frames → STT → falas → frases → tradução.
export class ChannelPipeline {
  private readonly sequencer = new ChannelSequencer();
  private readonly assembler: UtteranceAssembler;
  private readonly splitter: SentenceSplitter | null;
  private stt: SttStream | null;
  private sttStartedAt: number | null = null;
  private readonly recentSentences: string[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private onUtteranceClosed: (() => void) | null = null;

  constructor(private readonly deps: ChannelPipelineDeps) {
    this.assembler = new UtteranceAssembler(deps.channel);
    this.splitter = deps.translator ? new SentenceSplitter((sentence) => this.translate(sentence)) : null;
    this.stt = deps.sttFactory(deps.channel, {
      onResult: (result) => this.onSttResult(result),
      onError: (error) => this.onSttError(error),
    });
  }

  acceptFrame(frame: AudioFrame): boolean {
    const result = this.sequencer.accept(frame.frameSeq, frame.sampleOffset, frameSamples(frame));
    if (!result.accepted) return false;
    if (result.gapSamples > 0) {
      this.deps.emit({ type: "audio.gap", channel: this.deps.channel, durationMs: samplesToMs(result.gapSamples), reason: "client_drop" });
    }
    if (this.stt) {
      this.sttStartedAt ??= this.deps.now();
      this.stt.write(frame.pcm);
    }
    return true;
  }

  /** Parar: pede ao STT o que falta (até 500 ms) e espera as traduções em andamento (até 2 s). */
  async drain(): Promise<void> {
    if (this.stt && this.assembler.hasOpenUtterance) {
      const closed = new Promise<void>((resolve) => {
        this.onUtteranceClosed = resolve;
      });
      this.stt.finalize();
      await Promise.race([closed, delay(FINALIZE_WAIT_MS)]);
      this.onUtteranceClosed = null;
    }
    this.handleAll(this.assembler.forceClose());
    if (this.inflight.size > 0) await Promise.race([Promise.allSettled([...this.inflight]), delay(TRANSLATION_DRAIN_MS)]);
  }

  close(): void {
    this.splitter?.dispose();
    this.stt?.close();
    this.stt = null;
  }

  private onSttResult(result: SttResult): void {
    if (result.kind === "segment" && result.text && this.sttStartedAt !== null) {
      // Aproximação: o áudio é enviado em tempo real, então o fim da fala no stream ≈ início + end.
      this.deps.latency.stt.add(this.deps.now() - (this.sttStartedAt + result.end * 1_000));
    }
    this.handleAll(this.assembler.push(result));
  }

  private onSttError(error: Error): void {
    if (!this.stt) return;
    this.stt.close();
    this.stt = null;
    console.warn(`STT do canal ${this.deps.channel} parou: ${error.message}`);
    this.handleAll(this.assembler.forceClose());
    this.deps.emit({
      type: "error",
      scope: "stt",
      code: "stt_connection_lost",
      retryable: false,
      channel: this.deps.channel,
      message: "A transcrição parou: a conexão com o provedor caiu.",
    });
  }

  private handleAll(outputs: AssemblerOutput[]): void {
    for (const output of outputs) this.handle(output);
  }

  private handle(output: AssemblerOutput): void {
    this.deps.emit({ ...output, channel: this.deps.channel });
    if (output.type === "transcript.segment") this.splitter?.addSegment(output.utteranceId, output.text);
    if (output.type === "utterance.end") {
      this.splitter?.endUtterance(output.utteranceId);
      this.onUtteranceClosed?.();
    }
  }

  private translate(sentence: SentenceReady): void {
    const translator = this.deps.translator;
    if (!translator) return;
    const context = this.recentSentences.slice(-CONTEXT_SENTENCES).join(" ");
    this.recentSentences.push(sentence.text);
    if (this.recentSentences.length > CONTEXT_SENTENCES) this.recentSentences.shift();

    const startedAt = this.deps.now();
    const { channel } = this.deps;
    const task = translateWithRetry(translator, sentence.text, context).then(
      (text) => {
        this.deps.latency.translation.add(this.deps.now() - startedAt);
        this.deps.emit({ type: "translation", channel, utteranceId: sentence.utteranceId, sentenceIdx: sentence.sentenceIdx, source: sentence.text, text });
      },
      (error: unknown) => {
        console.warn(`tradução falhou: ${errorText(error)}`);
        this.deps.emit({ type: "translation.error", channel, utteranceId: sentence.utteranceId, sentenceIdx: sentence.sentenceIdx });
      },
    );
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }
}
```

Substituir `apps/server/src/session.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { AudioFrame, Channel, Mode, ServerEventBody, ServerMessage } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { LatencyStats, formatLatency } from "./latency";
import type { SttFactory } from "./stt/types";
import type { Translator } from "./translate/translator";

export interface SessionDeps {
  sttFactory: SttFactory;
  translator: Translator | null;
  send: (message: ServerMessage) => void;
  now?: () => number;
}

export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private closed = false;
  private readonly latency = { stt: new LatencyStats(), translation: new LatencyStats() };
  private readonly pipelines: Record<Channel, ChannelPipeline>;

  constructor(
    private readonly deps: SessionDeps,
    readonly mode: Mode,
    readonly context: string,
  ) {
    const now = deps.now ?? Date.now;
    const pipeline = (channel: Channel): ChannelPipeline =>
      new ChannelPipeline({
        channel,
        sttFactory: deps.sttFactory,
        translator: channel === "them" ? deps.translator : null,
        emit: (body) => this.emit(body),
        latency: this.latency,
        now,
      });
    this.pipelines = { them: pipeline("them"), me: pipeline("me") };
  }

  acceptFrame(frame: AudioFrame): boolean {
    return this.pipelines[frame.channel].acceptFrame(frame);
  }

  async drain(): Promise<void> {
    await Promise.all([this.pipelines.them.drain(), this.pipelines.me.drain()]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pipelines.them.close();
    this.pipelines.me.close();
    console.info(
      `sessão ${this.id.slice(0, 8)} encerrada · ${formatLatency("STT (segmento final)", this.latency.stt)} · ${formatLatency("tradução", this.latency.translation)}`,
    );
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.send({ v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body });
  }
}
```

Em `apps/server/src/gateway.ts`:
- `GatewayDeps` passa a ser `{ sttFactory: SttFactory; translator: Translator | null }` (import `type Translator` de `./translate/translator`).
- A criação da sessão vira `new Session({ sttFactory: deps.sttFactory, translator: deps.translator, send }, message.mode, message.context)`.
- Declarar `let stopping = false;` ao lado de `session`, e no começo do ramo binário, depois do teste `if (!session)`, acrescentar `if (stopping) return;`. No ramo de texto, depois do bloco `if (!session) { … }`, acrescentar `if (stopping) return;`.
- Substituir o tratamento de `session.stop` por:

```ts
    if (message?.type === "session.stop") {
      stopping = true;
      const current = session;
      // Entrega as últimas palavras e traduções antes de encerrar.
      void current.drain().finally(() => {
        send({ v: 1, type: "session.ended", sessionId: current.id, reason: "stopped" });
        current.close();
        ws.close(CLOSE_CODES.sessionEnded, "stopped");
      });
      return;
    }
```

Em `apps/server/src/config.ts`, acrescentar à interface `deepgramApiKey: string | null; deeplApiKey: string | null;` e ao retorno de `loadConfig`:

```ts
    deepgramApiKey: env.DEEPGRAM_API_KEY?.trim() || null,
    deeplApiKey: env.DEEPL_API_KEY?.trim() || null,
```

Criar `apps/server/src/providers.ts`:

```ts
import type { ServerConfig } from "./config";
import { createDeepgramSttFactory } from "./stt/deepgram-stt";
import { createFakeSttFactory } from "./stt/fake-stt";
import type { SttFactory } from "./stt/types";
import { createDeepLTranslator } from "./translate/deepl-translator";
import { createFakeTranslator } from "./translate/fake-translator";
import type { Translator } from "./translate/translator";

export interface Providers {
  sttFactory: SttFactory;
  translator: Translator;
  description: string;
}

export function createProviders(config: ServerConfig): Providers {
  const stt = config.deepgramApiKey
    ? { factory: createDeepgramSttFactory({ apiKey: config.deepgramApiKey }), label: "Deepgram" }
    : { factory: createFakeSttFactory(), label: "falso (sem DEEPGRAM_API_KEY)" };
  const translation = config.deeplApiKey
    ? { translator: createDeepLTranslator({ apiKey: config.deeplApiKey }), label: "DeepL" }
    : { translator: createFakeTranslator(), label: "falsa (sem DEEPL_API_KEY)" };
  return {
    sttFactory: stt.factory,
    translator: translation.translator,
    description: `STT: ${stt.label} · tradução: ${translation.label}`,
  };
}
```

Substituir `apps/server/src/main.ts`:

```ts
import { loadConfig } from "./config";
import { startGateway } from "./gateway";
import { createProviders } from "./providers";

const config = loadConfig();
const providers = createProviders(config);
const gateway = await startGateway(config, { sttFactory: providers.sttFactory, translator: providers.translator });
console.log(`SnowSpeak server ouvindo em ${config.host}:${config.port} (ws em /ws, tom de teste em /tone)`);
console.log(providers.description);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

Acrescentar ao fim de `apps/server/.env.example`:

```
# provedores (sem chave, o servidor usa versões falsas)
DEEPGRAM_API_KEY=
DEEPL_API_KEY=
```

- [ ] **Step 4: Rodar toda a suíte do servidor e o typecheck**

Run: `pnpm test apps/server && pnpm --filter @snowspeak/server typecheck`
Expected: PASS em todos os testes do servidor (inclusive os do marco 1 em `gateway.test.ts`) e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add apps/server
git commit -m "feat(server): pipeline de transcrição e tradução por canal, Parar com finalização e métricas de latência"
```

---

### Task 7: Store com as falas (captions) e texto exibido

**Files:**
- Modify: `apps/extension/src/offscreen/session-store.ts`, `apps/extension/src/offscreen/session-store.test.ts`
- Create: `apps/extension/src/sidepanel/caption-view.ts`
- Test: `apps/extension/src/sidepanel/caption-view.test.ts`

**Interfaces:**
- Consumes: eventos da Task 1.
- Produces:
  - `MAX_CAPTIONS = 200`
  - `interface Caption { utteranceId: string; channel: Channel; segments: string[]; partial: string; ended: boolean; interrupted: boolean; translations: Record<number, string | null> }` (`null` = tradução falhou)
  - `ChannelView` perde `lastPartial`; `SessionState` ganha `captions: Caption[]` e `notice: string | null`
  - `interface CaptionView { speaker: string; english: string; partial: string; portuguese: string; translating: boolean; translationFailed: boolean; interrupted: boolean }`, `captionView(caption: Caption): CaptionView`

- [ ] **Step 1: Escrever os testes**

Em `apps/extension/src/offscreen/session-store.test.ts`:
- trocar a fábrica `partial` para incluir `utteranceId: "them-1"`;
- nos testes que liam `channels.them.lastPartial`, passar a ler `captions[0]?.partial` (em `aplica o texto parcial…` esperar `"dois"`; em `session.ended…` esperar `"último"`; em `snapshot devolve…` usar `toMatchObject({ status: "running", captions: [{ partial: "olá" }] })`);
- acrescentar:

```ts
const event = (seq: number, body: Record<string, unknown>): ServerMessage =>
  ({ v: 1, sessionId: "s1", seq, ts: 0, channel: "them", utteranceId: "them-1", ...body }) as ServerMessage;

describe("falas", () => {
  it("monta a fala com parcial, segmentos estáveis e fim", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: event(1, { type: "transcript.partial", text: "hel" }) },
      { type: "server", message: event(2, { type: "transcript.segment", segmentIdx: 0, text: "Hello there." }) },
      { type: "server", message: event(3, { type: "transcript.partial", text: "how" }) },
      { type: "server", message: event(4, { type: "utterance.end", interrupted: false }) },
    );
    expect(state.captions).toEqual([
      { utteranceId: "them-1", channel: "them", segments: ["Hello there."], partial: "", ended: true, interrupted: false, translations: {} },
    ]);
  });

  it("guarda traduções por frase e marca as que falharam", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: event(1, { type: "transcript.segment", segmentIdx: 0, text: "Hi. Bye." }) },
      { type: "server", message: event(2, { type: "translation", sentenceIdx: 1, source: "Bye.", text: "Tchau." }) },
      { type: "server", message: event(3, { type: "translation.error", sentenceIdx: 0 }) },
    );
    expect(state.captions[0]?.translations).toEqual({ 0: null, 1: "Tchau." });
  });

  it("remove a fala encerrada sem nenhum segmento estável", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: event(1, { type: "transcript.partial", text: "uh" }) },
      { type: "server", message: event(2, { type: "utterance.end", interrupted: true }) },
    );
    expect(state.captions).toEqual([]);
  });

  it("mantém as falas dos dois canais na ordem em que começaram", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: event(1, { type: "transcript.partial", text: "a" }) },
      { type: "server", message: event(2, { type: "transcript.partial", channel: "me", utteranceId: "me-1", text: "b" }) },
      { type: "server", message: event(3, { type: "transcript.segment", segmentIdx: 0, text: "A." }) },
    );
    expect(state.captions.map((c) => c.utteranceId)).toEqual(["them-1", "me-1"]);
  });

  it("guarda no máximo as 200 falas mais recentes", () => {
    const actions: StoreAction[] = [{ type: "server", message: started }];
    for (let i = 1; i <= 205; i++) {
      actions.push({ type: "server", message: event(i, { type: "transcript.partial", utteranceId: `them-${i}`, text: `t${i}` }) });
    }
    const state = run(...actions);
    expect(state.captions).toHaveLength(MAX_CAPTIONS);
    expect(state.captions[0]?.utteranceId).toBe("them-6");
  });

  it("evento de erro vira aviso sem encerrar a sessão", () => {
    const state = run(
      { type: "starting" },
      { type: "server", message: started },
      {
        type: "server",
        message: { v: 1, sessionId: "s1", seq: 1, ts: 0, type: "error", scope: "stt", code: "stt_connection_lost", retryable: false, channel: "them", message: "A transcrição parou." },
      },
    );
    expect(state).toMatchObject({ status: "running", notice: "A transcrição parou." });
  });

  it("um novo início limpa falas e avisos anteriores", () => {
    const state = run(
      { type: "server", message: started },
      { type: "server", message: event(1, { type: "transcript.partial", text: "old" }) },
      { type: "starting" },
    );
    expect(state.captions).toEqual([]);
    expect(state.notice).toBeNull();
  });
});
```

(importar `MAX_CAPTIONS` de `./session-store`.)

Criar `apps/extension/src/sidepanel/caption-view.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Caption } from "../offscreen/session-store";
import { captionView } from "./caption-view";

const caption = (overrides: Partial<Caption>): Caption => ({
  utteranceId: "them-1",
  channel: "them",
  segments: [],
  partial: "",
  ended: false,
  interrupted: false,
  translations: {},
  ...overrides,
});

describe("captionView", () => {
  it("junta os segmentos e mostra o parcial separado", () => {
    expect(captionView(caption({ segments: ["Hello there.", "How are"], partial: "you" }))).toMatchObject({
      speaker: "Participantes",
      english: "Hello there. How are",
      partial: "you",
    });
  });

  it("junta as traduções na ordem das frases", () => {
    const view = captionView(caption({ segments: ["Hi. Bye."], translations: { 1: "Tchau.", 0: "Oi." } }));
    expect(view.portuguese).toBe("Oi. Tchau.");
    expect(view.translating).toBe(false);
  });

  it("indica tradução em andamento enquanto nenhuma frase chegou", () => {
    expect(captionView(caption({ segments: ["Hello."] })).translating).toBe(true);
    expect(captionView(caption({ partial: "hel" })).translating).toBe(false);
  });

  it("marca falha de tradução", () => {
    const view = captionView(caption({ segments: ["Hi."], translations: { 0: null } }));
    expect(view).toMatchObject({ translationFailed: true, translating: false, portuguese: "" });
  });

  it("falas do usuário não têm tradução", () => {
    expect(captionView(caption({ channel: "me", utteranceId: "me-1", segments: ["Sure."] }))).toMatchObject({
      speaker: "Você",
      translating: false,
      portuguese: "",
    });
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/extension`
Expected: FAIL — `captions`/`notice` inexistentes no estado e `./caption-view` inexistente.

- [ ] **Step 3: Implementar**

Em `apps/extension/src/offscreen/session-store.ts`:
- remover `lastPartial` de `ChannelView` e de `emptyChannel()`;
- acrescentar:

```ts
export const MAX_CAPTIONS = 200;

export interface Caption {
  utteranceId: string;
  channel: Channel;
  segments: string[];
  partial: string;
  ended: boolean;
  interrupted: boolean;
  /** Por sentenceIdx; null = a tradução daquela frase falhou. */
  translations: Record<number, string | null>;
}
```

- em `SessionState`, acrescentar `captions: Caption[];` e `notice: string | null;` e em `initialState()` `captions: [], notice: null`;
- acrescentar as funções:

```ts
function withCaption(state: SessionState, channel: Channel, utteranceId: string, update: (caption: Caption) => Caption): SessionState {
  const index = state.captions.findIndex((c) => c.utteranceId === utteranceId);
  const current: Caption =
    index >= 0
      ? (state.captions[index] as Caption)
      : { utteranceId, channel, segments: [], partial: "", ended: false, interrupted: false, translations: {} };
  const captions = [...state.captions];
  if (index >= 0) captions[index] = update(current);
  else captions.push(update(current));
  return { ...state, captions: captions.slice(-MAX_CAPTIONS) };
}

function endCaption(state: SessionState, utteranceId: string, interrupted: boolean): SessionState {
  const caption = state.captions.find((c) => c.utteranceId === utteranceId);
  if (!caption) return state;
  // Fala que terminou sem nenhum trecho estável não aparece na legenda.
  if (caption.segments.length === 0) return { ...state, captions: state.captions.filter((c) => c !== caption) };
  return withCaption(state, caption.channel, utteranceId, (c) => ({ ...c, ended: true, interrupted, partial: "" }));
}
```

- substituir o `switch` de eventos em `applyServerMessage` por:

```ts
  switch (message.type) {
    case "transcript.partial":
      return withCaption(next, message.channel, message.utteranceId, (c) => ({ ...c, partial: message.text }));
    case "transcript.segment":
      return withCaption(next, message.channel, message.utteranceId, (c) => {
        const segments = [...c.segments];
        segments[message.segmentIdx] = message.text;
        return { ...c, segments, partial: "" };
      });
    case "utterance.end":
      return endCaption(next, message.utteranceId, message.interrupted);
    case "translation":
      return withCaption(next, message.channel, message.utteranceId, (c) => ({
        ...c,
        translations: { ...c.translations, [message.sentenceIdx]: message.text },
      }));
    case "translation.error":
      return withCaption(next, message.channel, message.utteranceId, (c) => ({
        ...c,
        translations: { ...c.translations, [message.sentenceIdx]: null },
      }));
    case "audio.gap":
      return withChannel(next, message.channel, { lostMs: next.channels[message.channel].lostMs + message.durationMs });
    case "error":
      return { ...next, notice: message.message };
  }
```

Criar `apps/extension/src/sidepanel/caption-view.ts`:

```ts
import type { Caption } from "../offscreen/session-store";

export interface CaptionView {
  speaker: string;
  english: string;
  partial: string;
  portuguese: string;
  translating: boolean;
  translationFailed: boolean;
  interrupted: boolean;
}

export function captionView(caption: Caption): CaptionView {
  const english = caption.segments.filter(Boolean).join(" ");
  const indexes = Object.keys(caption.translations)
    .map(Number)
    .sort((a, b) => a - b);
  const translated = indexes.map((i) => caption.translations[i]).filter((t): t is string => typeof t === "string");
  const translationFailed = indexes.some((i) => caption.translations[i] === null);
  return {
    speaker: caption.channel === "them" ? "Participantes" : "Você",
    english,
    partial: caption.partial,
    portuguese: translated.join(" "),
    translating: caption.channel === "them" && english !== "" && indexes.length === 0,
    translationFailed,
    interrupted: caption.interrupted,
  };
}
```

- [ ] **Step 4: Rodar os testes e o typecheck**

Run: `pnpm test apps/extension && pnpm --filter @snowspeak/extension typecheck`
Expected: testes PASS. O typecheck acusa apenas `sidepanel/main.ts` ainda lendo `view.lastPartial` — isso é corrigido na Task 8; qualquer outro erro deve ser corrigido aqui.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/offscreen/session-store.ts apps/extension/src/offscreen/session-store.test.ts apps/extension/src/sidepanel/caption-view.ts apps/extension/src/sidepanel/caption-view.test.ts
git commit -m "feat(extension): falas com segmentos e traduções no estado da sessão"
```

---

### Task 8: Legenda no painel

**Files:**
- Create: `apps/extension/src/offscreen/coalesce.ts`
- Test: `apps/extension/src/offscreen/coalesce.test.ts`
- Modify: `apps/extension/src/offscreen/main.ts`, `apps/extension/sidepanel.html`, `apps/extension/src/sidepanel/main.ts`, `apps/extension/src/sidepanel/sidepanel.css`

**Interfaces:**
- Consumes: `SessionState`, `Caption` (Task 7), `captionView` (Task 7).
- Produces: `BROADCAST_INTERVAL_MS = 50`, `createCoalescer(flush: () => void, delayMs: number): () => void`.

- [ ] **Step 1: Escrever o teste do agrupador**

Criar `apps/extension/src/offscreen/coalesce.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoalescer } from "./coalesce";

describe("createCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("agrupa vários pedidos num único envio após o intervalo", () => {
    const flush = vi.fn();
    const schedule = createCoalescer(flush, 50);
    schedule();
    schedule();
    schedule();
    expect(flush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("um pedido depois do envio agenda um novo", () => {
    const flush = vi.fn();
    const schedule = createCoalescer(flush, 50);
    schedule();
    vi.advanceTimersByTime(50);
    schedule();
    vi.advanceTimersByTime(50);
    expect(flush).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/extension/src/offscreen/coalesce.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementar agrupador e painel**

Criar `apps/extension/src/offscreen/coalesce.ts`:

```ts
// O estado muda muitas vezes por segundo (níveis, parciais); o painel recebe no máximo um envio a cada intervalo.
export const BROADCAST_INTERVAL_MS = 50;

export function createCoalescer(flush: () => void, delayMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, delayMs);
  };
}
```

Em `apps/extension/src/offscreen/main.ts`, trocar o `store.subscribe(...)` por:

```ts
const broadcast = createCoalescer(() => {
  const message: RuntimeMessage = { target: "sidepanel", type: "state", state: store.snapshot() };
  // O painel pode estar fechado; nesse caso não há receptor.
  chrome.runtime.sendMessage(message).catch(() => undefined);
}, BROADCAST_INTERVAL_MS);
store.subscribe(broadcast);
```

(com `import { BROADCAST_INTERVAL_MS, createCoalescer } from "./coalesce";`).

Substituir `apps/extension/sidepanel.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>SnowSpeak</title>
    <link rel="stylesheet" href="/src/sidepanel/sidepanel.css" />
  </head>
  <body>
    <header>
      <h1>SnowSpeak</h1>
      <span id="status" class="status">Parado</span>
    </header>

    <details id="settings" class="settings" open>
      <summary>Configurações</summary>
      <label>Servidor <input id="serverUrl" type="url" /></label>
      <label>Chave de acesso <input id="token" type="password" autocomplete="off" /></label>
      <label>
        Modo
        <select id="mode">
          <option value="work">Trabalho</option>
          <option value="sales">Vendas</option>
          <option value="interview">Entrevista</option>
          <option value="relationship">Relacionamento</option>
        </select>
      </label>
      <label>Contexto <textarea id="context" rows="3"></textarea></label>
    </details>

    <div class="actions">
      <button id="start">Iniciar</button>
      <button id="stop" disabled>Parar</button>
    </div>

    <p id="mic-permission" class="notice" hidden>
      O microfone ainda não foi liberado. <button id="grant-mic">Liberar microfone</button>
    </p>
    <p id="local-error" class="error" hidden></p>
    <p id="error" class="error" hidden></p>
    <p id="notice" class="warning" hidden></p>
    <p id="mic-denied" class="warning" hidden>Sugestões sem suas falas: microfone indisponível.</p>

    <div class="meters">
      <div class="channel" data-channel="them">
        <span class="label">Participantes</span>
        <div class="meter"><div class="bar"></div></div>
        <span class="stats"></span>
      </div>
      <div class="channel" data-channel="me">
        <span class="label">Você</span>
        <div class="meter"><div class="bar"></div></div>
        <span class="stats"></span>
      </div>
    </div>

    <ol id="captions" class="captions" aria-live="polite"></ol>

    <script type="module" src="/src/sidepanel/main.ts"></script>
  </body>
</html>
```

Substituir `apps/extension/src/sidepanel/sidepanel.css`:

```css
:root {
  color-scheme: dark;
  --bg: #111418;
  --surface: #1c2026;
  --border: #2c323a;
  --fg: #e8eaed;
  --muted: #9aa0a6;
  --accent: #5ab0ff;
  --translation: #8fd18f;
  --me: #c9a7ff;
  --error: #ff6b6b;
  --warning: #f4c542;
}

html,
body {
  height: 100%;
}

body {
  margin: 0;
  padding: 12px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.4 system-ui, sans-serif;
}

header { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 18px; margin: 0; }
.status { color: var(--muted); }

.settings { display: grid; gap: 8px; }
.settings summary { cursor: pointer; color: var(--muted); }
.settings label { display: grid; gap: 2px; color: var(--muted); margin-top: 6px; }
input, select, textarea, button { font: inherit; }
input, select, textarea { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px; }

.actions { display: flex; gap: 8px; }
button { background: var(--surface); color: var(--fg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:disabled { opacity: 0.4; cursor: default; }
#start:not(:disabled) { background: var(--accent); color: #0b1a2a; border-color: var(--accent); }

p { margin: 0; }
.error { color: var(--error); }
.warning { color: var(--warning); }
.notice { color: var(--muted); }

.meters { display: grid; gap: 4px; }
.channel { display: grid; grid-template-columns: 90px 1fr; align-items: center; column-gap: 8px; }
.channel .label { color: var(--muted); font-size: 12px; }
.meter { height: 4px; background: var(--surface); border-radius: 2px; overflow: hidden; }
.bar { height: 100%; width: 0; background: var(--accent); transition: width 120ms linear; }
.channel .stats { grid-column: 2; color: var(--muted); font-size: 11px; }

.captions {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.caption { padding: 8px 10px; border-radius: 8px; background: var(--surface); }
.caption-me { border-left: 3px solid var(--me); }
.caption-them { border-left: 3px solid var(--accent); }
.caption .speaker { font-size: 11px; color: var(--muted); }
.caption .english { font-size: 15px; }
.caption .partial { color: var(--muted); }
.caption .portuguese { color: var(--translation); font-size: 15px; margin-top: 2px; }
.caption .portuguese.pending { color: var(--muted); font-style: italic; font-size: 12px; }
.caption .portuguese.failed { color: var(--warning); font-size: 12px; }
.caption .interrupted { color: var(--muted); font-size: 11px; }
```

Em `apps/extension/src/sidepanel/main.ts`:
- importar `type Caption` junto de `SessionState` e `import { captionView } from "./caption-view";`;
- acrescentar as referências `const noticeLabel = byId<HTMLParagraphElement>("notice");`, `const settingsPanel = byId<HTMLDetailsElement>("settings");` e `const captionsList = byId<HTMLOListElement>("captions");`;
- acrescentar o renderizador de falas:

```ts
const captionItems = new Map<string, HTMLLIElement>();

function createCaptionItem(caption: Caption): HTMLLIElement {
  const item = document.createElement("li");
  item.className = `caption caption-${caption.channel}`;
  item.innerHTML =
    '<div class="speaker"></div><p class="english"><span class="final"></span> <span class="partial"></span></p>' +
    '<p class="portuguese"></p><div class="interrupted" hidden>fala interrompida</div>';
  return item;
}

function fillCaptionItem(item: HTMLLIElement, caption: Caption): void {
  const view = captionView(caption);
  (item.querySelector(".speaker") as HTMLElement).textContent = view.speaker;
  (item.querySelector(".final") as HTMLElement).textContent = view.english;
  (item.querySelector(".partial") as HTMLElement).textContent = view.partial;
  const portuguese = item.querySelector(".portuguese") as HTMLElement;
  portuguese.hidden = caption.channel === "me";
  portuguese.classList.toggle("pending", view.translating);
  portuguese.classList.toggle("failed", view.translationFailed && !view.portuguese);
  portuguese.textContent = view.portuguese || (view.translating ? "traduzindo…" : view.translationFailed ? "tradução indisponível" : "");
  (item.querySelector(".interrupted") as HTMLElement).hidden = !view.interrupted;
}

function renderCaptions(captions: Caption[]): void {
  const nearBottom = captionsList.scrollHeight - captionsList.scrollTop - captionsList.clientHeight < 60;
  const alive = new Set<string>();
  for (const caption of captions) {
    alive.add(caption.utteranceId);
    let item = captionItems.get(caption.utteranceId);
    if (!item) {
      item = createCaptionItem(caption);
      captionItems.set(caption.utteranceId, item);
      captionsList.append(item);
    }
    fillCaptionItem(item, caption);
  }
  for (const [id, item] of captionItems) {
    if (alive.has(id)) continue;
    item.remove();
    captionItems.delete(id);
  }
  // Acompanha a conversa, a menos que o usuário tenha rolado para ler algo anterior.
  if (nearBottom) captionsList.scrollTop = captionsList.scrollHeight;
}
```

- em `render()`, no laço dos canais, substituir as três linhas que preenchem `.bar`, `.stats` e `.partial` por:

```ts
    (section.querySelector(".bar") as HTMLElement).style.width = `${Math.min(100, view.level * 300)}%`;
    (section.querySelector(".stats") as HTMLElement).textContent =
      `${view.sentFrames} frames · ${view.droppedFrames} descartados · ${(view.lostMs / 1000).toFixed(1)} s perdidos`;
```

- ainda em `render()`, depois do laço:

```ts
  noticeLabel.hidden = !state.notice;
  noticeLabel.textContent = state.notice ?? "";
  renderCaptions(state.captions);
```

- em `applyState`, recolher as configurações quando uma sessão começa:

```ts
function applyState(state: SessionState): void {
  if (state.status === "starting" && lastState.status !== "starting") settingsPanel.open = false;
  lastState = state;
  render();
}
```

- [ ] **Step 4: Testes, typecheck e build**

Run: `pnpm test && pnpm -r typecheck && pnpm --filter @snowspeak/extension build`
Expected: todos os testes PASS, typecheck sem erros, build conclui.

- [ ] **Step 5: Commit**

```bash
git add apps/extension
git commit -m "feat(extension): legenda com inglês e tradução no painel"
```

---

### Task 9: Chaves, roteiro e validação com os provedores reais

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Atualizar o README**

Na seção "Desenvolvimento", depois do passo 3, acrescentar:

```markdown
   Para transcrição e tradução reais, preencha também `DEEPGRAM_API_KEY` (console.deepgram.com) e `DEEPL_API_KEY` (deepl.com/pro-api; a chave gratuita termina em `:fx`). Sem elas, o servidor usa versões falsas e avisa no log.
```

Substituir o título "O que o painel mostra no marco 1" e seu conteúdo por uma seção "O que o painel mostra" explicando: sem chaves, a sonda de sinal do marco 1; com chaves, a legenda (inglês com parcial em cinza, português em verde abaixo das falas dos participantes, falas do usuário em roxo sem tradução). Manter a menção a `/tone` como teste de áudio sem provedores.

Acrescentar ao fim:

```markdown
## Marcos 3 e 4 — roteiro de validação (com chaves reais)

- [ ] O log do servidor mostra `STT: Deepgram · tradução: DeepL`.
- [ ] Numa aba com um vídeo em inglês (entrevista, podcast), o inglês aparece enquanto a pessoa fala, primeiro em cinza (parcial) e depois firme.
- [ ] O português aparece abaixo de cada frase logo depois que ela termina.
- [ ] Fala longa sem pausa: a tradução aparece aos poucos (a cada frase ou a cada ~2,5 s), sem esperar o fim.
- [ ] Falando no microfone (inglês ou português), a fala aparece como "Você", sem tradução.
- [ ] Clicar em Parar no meio de uma frase: as últimas palavras aparecem e são traduzidas antes de o status virar "Parado".
- [ ] Fechar e reabrir o painel mantém a legenda.
- [ ] Chave do DeepL errada (troque no `.env` e reinicie o servidor): o inglês continua e aparece "tradução indisponível".
- [ ] Chave do Deepgram errada: aparece o aviso "A transcrição parou…" e a sessão segue capturando.
- [ ] Ao parar, o log do servidor mostra a latência (`STT (segmento final) p50 … · tradução p50 …`). Meta: tradução p50 < 800 ms.
- [ ] Repetir numa chamada real do Google Meet.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: chaves dos provedores e roteiro dos marcos 3 e 4"
```

- [ ] **Step 3: Validação manual com o usuário**

Com as chaves preenchidas pelo usuário em `apps/server/.env`, rodar `pnpm --filter @snowspeak/extension build`, recarregar a extensão, iniciar o servidor e percorrer o roteiro com o usuário, marcando `[x]` no README os itens que passarem e registrando as latências do log.
