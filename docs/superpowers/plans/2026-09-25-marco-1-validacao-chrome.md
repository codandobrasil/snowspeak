# Marco 1 — Validação no Chrome (sem provedores) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extensão do Chrome que captura o áudio da aba e do microfone, envia frames PCM a um servidor com STT falso e mostra no side panel níveis, contadores e o texto do STT falso — validando todo o caminho do Chrome antes de integrar Deepgram, DeepL ou Claude.

**Architecture:** Monorepo pnpm com três pacotes. `packages/shared` define o formato binário dos frames e as mensagens do protocolo. `apps/server` aceita o WebSocket, autentica com chave de acesso, valida frames e responde com um STT falso que emite `transcript.partial`. `apps/extension` (MV3) usa o offscreen document como dono da sessão: captura, AudioWorklet, socket e store; o side panel só exibe o estado.

**Tech Stack:** Node 20, TypeScript 5, pnpm 9 (corepack), Vitest, zod, `ws`, Vite, `@types/chrome`, Chrome ≥ 116.

**Spec:** `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md` (este plano implementa o §10 item 1 e as partes de §3, §4.1, §4.2, §4.3, §5.1 necessárias a ele).

## Global Constraints

- Áudio: PCM16LE mono 16 kHz; frames de até 100 ms (3.200 bytes de PCM); cabeçalho de 9 bytes `[canal:1][frameSeq:uint32 BE][sampleOffset:uint32 BE]`; canal 0 = `them`, 1 = `me`.
- `frameSeq` e `sampleOffset` começam em 0 por canal e avançam de forma independente; avançam também para frames descartados pelo cliente.
- Cliente descarta o frame (sem enfileirar) quando `WebSocket.bufferedAmount` > 32 KB.
- WebSocket abre sem credenciais na URL; `Origin` deve estar na lista permitida; primeira mensagem `session.start` em até 5 s, senão fechamento `4401`.
- Códigos de fechamento: `4400` protocolo, `4401` credencial, `4404` sessão inexistente, `4409` substituída, `4410` encerrada.
- Mensagens de controle do servidor não têm `seq`; eventos têm `seq` monotônico começando em 1, `ts` e envelope `v: 1`.
- `context` ≤ 2.000 caracteres; modos `work | sales | interview | relationship`.
- Offscreen document é o dono da sessão no cliente; service worker só coordena; side panel só exibe e reconstrói o estado ao reabrir.
- Áudio nunca é gravado em disco; logs sem conteúdo da conversa.
- Textos da interface em português do Brasil.
- Nenhuma chamada a Deepgram, DeepL ou Claude neste marco.

## Review Focus

1. Microfone negado ou nunca liberado → a sessão continua só com a aba e o painel mostra "Sugestões sem suas falas: microfone indisponível." (teste na Task 6: `segue só com a aba quando o microfone é negado`; Task 5: `registra microfone negado`).
2. Painel fechado e reaberto no meio da sessão → mostra o mesmo estado (teste na Task 5: `snapshot devolve o estado atual para um painel reaberto`; roteiro manual na Task 8).
3. Servidor fora do ar ou chave errada ao clicar Iniciar → mensagem clara e nenhuma captura de aba fica presa (testes na Task 6: `mostra erro de conexão e libera capturas...`, `mostra chave inválida no fechamento 4401`).
4. Frame malformado (payload ímpar ou grande demais) → descartado sem derrubar a conexão (teste na Task 3: `descarta frame malformado sem fechar a conexão`).
5. Clique duplo em Iniciar ou Parar durante a inicialização → uma única captura e nenhuma captura órfã (testes na Task 6: `ignora um segundo start...`, `stop durante a captura da aba descarta a captura atrasada`).

---

## Revisão 2 — correções aprovadas (prevalecem sobre o código das tasks abaixo)

Execução: nativa, com revisão independente ao final. Onde uma correção conflita com um bloco de código de uma task, vale a correção; o código final no repositório é a referência.

| # | Task | Correção |
|---|---|---|
| R1 | 2 | `parseServerMessage` valida com zod (`discriminatedUnion` por `type`): campos obrigatórios, `v: 1`, `channel ∈ {them, me}`, `seq` inteiro ≥ 1, `ts` numérico. Testes rejeitam evento sem `seq`, com canal inválido e controle sem `sessionId`. Inclui o evento `audio.gap { channel, durationMs, reason }`. |
| R2 | 6, 7 | `openSocket` fica dentro de `try`; erro síncrono (URL inválida) libera as capturas e mostra "Endereço do servidor inválido.". Prazo `SESSION_START_TIMEOUT_MS = 5000` entre abrir o socket e receber `session.started`; estourou → libera tudo e mostra "O servidor não respondeu a tempo.". O painel valida a URL (`ws:`/`wss:`) antes de enviar. |
| R3 | 7 | Cada início é uma tentativa identificada no service worker (`AttemptTracker`, módulo puro com testes): `begin()` recusa um segundo início pendente, `cancel()` (no Parar) invalida a tentativa em qualquer etapa anterior ao controlador, `isCurrent(id)` é verificado após cada `await`. O painel desabilita Iniciar no clique (estado local `pending`) e mantém Parar habilitado enquanto há início pendente. |
| R4 | 7 | `createCapturePipe` fecha o `AudioContext` se `addModule` ou a montagem do grafo falhar; `captureTab`/`captureMic` fecham contexto de reprodução e trilhas em qualquer falha parcial. |
| R5 | 3 | Servidor ganha `ChannelSequencer` (puro, com testes) por canal: rejeita `frameSeq` ≤ último aceito (duplicado/antigo) e `sampleOffset` < esperado (sobreposição); aceita lacunas e emite `audio.gap { reason: "client_drop", durationMs }` exato. Testes de integração cobrem duplicado e lacuna. |
| R6 | 6, 7 | `CaptureCallbacks.onEnded(channel)`: `capture.ts` escuta `ended` das trilhas. Fim da aba → envia `session.stop`, libera tudo, erro "A captura da aba terminou (aba fechada ou compartilhamento encerrado).". Fim do microfone → libera só o microfone, `mic: "denied"`, sessão continua. |
| R7 | 7, 8 | `streamId` sempre obtido no service worker: o clique no ícone (`openPanelOnActionClick: false`, `action.onClicked`) abre o painel e associa a aba (`invokedTabId` em `chrome.storage.session`); no Iniciar, o SW garante o offscreen, **então** chama `getMediaStreamId({ targetTabId })` e envia imediatamente ao offscreen. Contingência na Task 8: se o Chrome recusar fora do clique, o clique no ícone inicia a sessão diretamente com as configurações salvas. |
| R8 | 3, 8 | STT falso vira sonda de sinal (`SignalProbe`, puro): a cada 1 s de áudio aceito informa duração, nível em dBFS e frequência dominante por cruzamentos de zero (`[fake-stt them] 2.0 s · -9 dBFS · ~440 Hz`, ou `silêncio`). Nada é gravado. Teste unitário e de integração com seno de 440 Hz; o servidor serve `GET /tone` (página com oscilador 440 Hz) para o roteiro manual conferir duração, amplitude e frequência de ponta a ponta. |

Review Focus acrescido: 6. Aba capturada fechada ou compartilhamento encerrado → sessão encerra com mensagem e nada fica capturando (teste na Task 6: `encerra a sessão quando a captura da aba termina`; roteiro manual na Task 8).

O marco só está concluído após o roteiro no Chrome, incluindo fechar a aba capturada e parar durante a inicialização. As contagens de testes citadas nas tasks são previsões; vale o resultado executado.

---

## Estrutura de arquivos

```
package.json                     scripts raiz (test, typecheck, build)
pnpm-workspace.yaml
tsconfig.base.json
vitest.config.ts                 roda testes de todos os pacotes
.gitignore

packages/shared/
  package.json  tsconfig.json
  src/index.ts                   reexporta tudo
  src/audio-frame.ts             formato binário dos frames (encode/decode/validação)
  src/audio-frame.test.ts
  src/messages.ts                mensagens cliente↔servidor, códigos de fechamento
  src/messages.test.ts

apps/server/
  package.json  tsconfig.json  .env.example
  src/config.ts                  lê variáveis de ambiente
  src/config.test.ts
  src/stt/types.ts               interface SttStream
  src/stt/fake-stt.ts            STT falso guiado pelo áudio recebido
  src/stt/fake-stt.test.ts
  src/session.ts                 estado mínimo da sessão, seq dos eventos
  src/gateway.ts                 servidor HTTP + WebSocket, autenticação, frames
  src/gateway.test.ts            testes de integração com cliente ws
  src/main.ts                    ponto de entrada

apps/extension/
  package.json  tsconfig.json  vite.config.ts
  public/manifest.json
  sidepanel.html  offscreen.html  permission.html
  src/messaging.ts               tipos das mensagens chrome.runtime
  src/audio/pcm.ts               float→PCM16, RMS, acumulador de frames
  src/audio/pcm.test.ts
  src/audio/worklet-globals.d.ts
  src/audio/capture-worklet.ts   AudioWorkletProcessor
  src/offscreen/frame-sender.ts  numeração e descarte de frames
  src/offscreen/frame-sender.test.ts
  src/offscreen/session-store.ts estado exibido pelo painel (reducer puro)
  src/offscreen/session-store.test.ts
  src/offscreen/session-controller.ts orquestra captura + socket + store
  src/offscreen/session-controller.test.ts
  src/offscreen/capture.ts       getUserMedia da aba e do microfone
  src/offscreen/socket.ts        adaptador do WebSocket do navegador
  src/offscreen/main.ts          liga tudo no offscreen document
  src/background/service-worker.ts
  src/sidepanel/main.ts  src/sidepanel/sidepanel.css
  src/permission/main.ts         página que pede permissão do microfone

README.md                        como rodar em desenvolvimento
```

Nota sobre o servidor: o spec cita Fastify + ws. Neste marco só existe a rota WebSocket e `/health`, então o plano usa `node:http` + `ws` diretamente; Fastify entra quando houver rotas HTTP reais (subprojeto 2).

---

### Task 1: Monorepo e formato binário dos frames

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/index.ts`, `packages/shared/src/audio-frame.ts`
- Test: `packages/shared/src/audio-frame.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces (de `@snowspeak/shared`):
  - `SAMPLE_RATE = 16000`, `FRAME_HEADER_BYTES = 9`, `MAX_PCM_BYTES = 3200`, `MAX_FRAME_BYTES = 3209`
  - `type Channel = "them" | "me"`
  - `interface AudioFrame { channel: Channel; frameSeq: number; sampleOffset: number; pcm: Uint8Array }`
  - `encodeFrame(frame: AudioFrame): ArrayBuffer` (lança `RangeError` se o PCM for inválido)
  - `type FrameDecodeError = "too_short" | "too_long" | "odd_payload" | "bad_channel"`
  - `decodeFrame(data: Uint8Array): { ok: true; frame: AudioFrame } | { ok: false; reason: FrameDecodeError }`
  - `frameSamples(frame: AudioFrame): number`, `samplesToMs(samples: number): number`

- [ ] **Step 1: Instalar o pnpm e criar a raiz do monorepo**

```bash
corepack enable --install-directory ~/.local/bin pnpm
pnpm --version
```
Expected: versão 9.x ou superior impressa.

Criar `package.json`:

```json
{
  "name": "snowspeak",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "pnpm -r typecheck",
    "build": "pnpm -r build"
  }
}
```

Criar `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Criar `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "resolveJsonModule": true
  }
}
```

Criar `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
  },
});
```

Criar `.gitignore`:

```
node_modules/
dist/
.env
```

Criar `packages/shared/package.json`:

```json
{
  "name": "@snowspeak/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc -p tsconfig.json" }
}
```

Criar `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": [] },
  "include": ["src"]
}
```

Instalar dependências:

```bash
pnpm add -Dw typescript vitest @types/node
pnpm --filter @snowspeak/shared add zod
```

- [ ] **Step 2: Escrever os testes do formato de frame**

Criar `packages/shared/src/audio-frame.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_BYTES,
  MAX_PCM_BYTES,
  decodeFrame,
  encodeFrame,
  frameSamples,
  samplesToMs,
  type AudioFrame,
} from "./audio-frame";

function pcmOf(bytes: number, fill = 7): Uint8Array {
  return new Uint8Array(bytes).fill(fill);
}

describe("encodeFrame/decodeFrame", () => {
  it("faz ida e volta preservando canal, contadores e PCM", () => {
    const frame: AudioFrame = { channel: "me", frameSeq: 42, sampleOffset: 67_200, pcm: pcmOf(MAX_PCM_BYTES) };
    const encoded = encodeFrame(frame);
    expect(encoded.byteLength).toBe(MAX_FRAME_BYTES);

    const decoded = decodeFrame(new Uint8Array(encoded));
    expect(decoded).toEqual({ ok: true, frame });
  });

  it("usa canal 0 para them e 1 para me, com inteiros big-endian", () => {
    const encoded = new Uint8Array(encodeFrame({ channel: "them", frameSeq: 1, sampleOffset: 256, pcm: pcmOf(2) }));
    expect(Array.from(encoded.subarray(0, 9))).toEqual([0, 0, 0, 0, 1, 0, 0, 1, 0]);
  });

  it("decodifica a partir de uma view com byteOffset diferente de zero", () => {
    const encoded = new Uint8Array(encodeFrame({ channel: "them", frameSeq: 3, sampleOffset: 4800, pcm: pcmOf(4) }));
    const pool = new Uint8Array(encoded.byteLength + 5);
    pool.set(encoded, 5);
    const result = decodeFrame(pool.subarray(5));
    expect(result.ok && result.frame.sampleOffset).toBe(4800);
  });

  it("rejeita frames curtos, longos, ímpares e de canal desconhecido", () => {
    expect(decodeFrame(new Uint8Array(10))).toEqual({ ok: false, reason: "too_short" });
    expect(decodeFrame(new Uint8Array(MAX_FRAME_BYTES + 2))).toEqual({ ok: false, reason: "too_long" });
    expect(decodeFrame(new Uint8Array(9 + 3))).toEqual({ ok: false, reason: "odd_payload" });
    const badChannel = new Uint8Array(9 + 2);
    badChannel[0] = 2;
    expect(decodeFrame(badChannel)).toEqual({ ok: false, reason: "bad_channel" });
  });

  it("recusa codificar PCM vazio, ímpar ou maior que 100 ms", () => {
    const base = { channel: "them" as const, frameSeq: 0, sampleOffset: 0 };
    expect(() => encodeFrame({ ...base, pcm: pcmOf(0) })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, pcm: pcmOf(3) })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, pcm: pcmOf(MAX_PCM_BYTES + 2) })).toThrow(RangeError);
  });
});

describe("duração", () => {
  it("calcula samples e milissegundos, inclusive de um frame final curto", () => {
    const frame: AudioFrame = { channel: "them", frameSeq: 0, sampleOffset: 0, pcm: pcmOf(800) };
    expect(frameSamples(frame)).toBe(400);
    expect(samplesToMs(400)).toBe(25);
    expect(samplesToMs(1600)).toBe(100);
  });
});
```

- [ ] **Step 3: Rodar os testes e confirmar a falha**

Run: `pnpm test packages/shared/src/audio-frame.test.ts`
Expected: FAIL — `Failed to resolve import "./audio-frame"`.

- [ ] **Step 4: Implementar o formato de frame**

Criar `packages/shared/src/audio-frame.ts`:

```ts
export const SAMPLE_RATE = 16_000;
export const FRAME_HEADER_BYTES = 9;
export const MAX_PCM_BYTES = 3_200; // 100 ms de PCM16 mono a 16 kHz
export const MAX_FRAME_BYTES = FRAME_HEADER_BYTES + MAX_PCM_BYTES;

export type Channel = "them" | "me";

const CHANNEL_CODES: Record<Channel, number> = { them: 0, me: 1 };
const CHANNELS_BY_CODE: readonly Channel[] = ["them", "me"];

export interface AudioFrame {
  channel: Channel;
  frameSeq: number;
  sampleOffset: number;
  pcm: Uint8Array;
}

export type FrameDecodeError = "too_short" | "too_long" | "odd_payload" | "bad_channel";

export type FrameDecodeResult =
  | { ok: true; frame: AudioFrame }
  | { ok: false; reason: FrameDecodeError };

export function encodeFrame(frame: AudioFrame): ArrayBuffer {
  const pcmBytes = frame.pcm.byteLength;
  if (pcmBytes < 2 || pcmBytes > MAX_PCM_BYTES || pcmBytes % 2 !== 0) {
    throw new RangeError(`PCM inválido: ${pcmBytes} bytes`);
  }
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + pcmBytes);
  const view = new DataView(buffer);
  view.setUint8(0, CHANNEL_CODES[frame.channel]);
  view.setUint32(1, frame.frameSeq);
  view.setUint32(5, frame.sampleOffset);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(frame.pcm);
  return buffer;
}

export function decodeFrame(data: Uint8Array): FrameDecodeResult {
  if (data.byteLength < FRAME_HEADER_BYTES + 2) return { ok: false, reason: "too_short" };
  if (data.byteLength > MAX_FRAME_BYTES) return { ok: false, reason: "too_long" };
  if ((data.byteLength - FRAME_HEADER_BYTES) % 2 !== 0) return { ok: false, reason: "odd_payload" };

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const channel = CHANNELS_BY_CODE[view.getUint8(0)];
  if (!channel) return { ok: false, reason: "bad_channel" };

  return {
    ok: true,
    frame: {
      channel,
      frameSeq: view.getUint32(1),
      sampleOffset: view.getUint32(5),
      pcm: data.subarray(FRAME_HEADER_BYTES),
    },
  };
}

export function frameSamples(frame: AudioFrame): number {
  return frame.pcm.byteLength / 2;
}

export function samplesToMs(samples: number): number {
  return (samples * 1000) / SAMPLE_RATE;
}
```

Criar `packages/shared/src/index.ts`:

```ts
export * from "./audio-frame";
```

- [ ] **Step 5: Rodar os testes e o typecheck**

Run: `pnpm test packages/shared && pnpm --filter @snowspeak/shared typecheck`
Expected: PASS (6 testes) e typecheck sem erros.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json vitest.config.ts .gitignore packages/shared
git commit -m "feat(shared): monorepo e formato binário dos frames de áudio"
```

---

### Task 2: Mensagens do protocolo

**Files:**
- Create: `packages/shared/src/messages.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/messages.test.ts`

**Interfaces:**
- Consumes: `Channel` (Task 1).
- Produces (de `@snowspeak/shared`):
  - `MODES`, `type Mode = "work" | "sales" | "interview" | "relationship"`, `MAX_CONTEXT_CHARS = 2000`
  - `CLOSE_CODES = { protocolError: 4400, unauthorized: 4401, sessionNotFound: 4404, superseded: 4409, sessionEnded: 4410 }`
  - `type ClientMessage = { type: "session.start"; token: string; mode: Mode; context: string } | { type: "session.stop" }`
  - `parseClientMessage(raw: string): ClientMessage | null`
  - `type SessionEndReason = "stopped" | "replaced" | "expired" | "max_duration" | "error"`
  - `type ServerControl = { v: 1; type: "session.started"; sessionId: string; resumeToken: string } | { v: 1; type: "session.ended"; sessionId: string; reason: SessionEndReason }`
  - `interface EventEnvelope { v: 1; sessionId: string; seq: number; ts: number; channel?: Channel; utteranceId?: string }`
  - `type ServerEventBody = { type: "transcript.partial"; channel: Channel; text: string }`
  - `type ServerEvent = EventEnvelope & ServerEventBody`, `type ServerMessage = ServerControl | ServerEvent`
  - `isServerEvent(m: ServerMessage): m is ServerEvent`, `parseServerMessage(raw: string): ServerMessage | null`

- [ ] **Step 1: Escrever os testes**

Criar `packages/shared/src/messages.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_CHARS, isServerEvent, parseClientMessage, parseServerMessage, type ServerMessage } from "./messages";

describe("parseClientMessage", () => {
  it("aceita session.start válido", () => {
    const raw = JSON.stringify({ type: "session.start", token: "k", mode: "interview", context: "dev backend" });
    expect(parseClientMessage(raw)).toEqual({ type: "session.start", token: "k", mode: "interview", context: "dev backend" });
  });

  it("aceita session.stop", () => {
    expect(parseClientMessage('{"type":"session.stop"}')).toEqual({ type: "session.stop" });
  });

  it("rejeita contexto acima de 2.000 caracteres", () => {
    const raw = JSON.stringify({ type: "session.start", token: "k", mode: "work", context: "x".repeat(MAX_CONTEXT_CHARS + 1) });
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("rejeita modo desconhecido, token vazio, tipo desconhecido e JSON inválido", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.start", token: "k", mode: "party", context: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "session.start", token: "", mode: "work", context: "" }))).toBeNull();
    expect(parseClientMessage('{"type":"session.explode"}')).toBeNull();
    expect(parseClientMessage("{not json")).toBeNull();
  });
});

describe("mensagens do servidor", () => {
  it("distingue eventos (com seq) de mensagens de controle", () => {
    const control: ServerMessage = { v: 1, type: "session.started", sessionId: "s", resumeToken: "r" };
    const event: ServerMessage = { v: 1, type: "transcript.partial", sessionId: "s", seq: 1, ts: 0, channel: "them", text: "hi" };
    expect(isServerEvent(control)).toBe(false);
    expect(isServerEvent(event)).toBe(true);
  });

  it("parseServerMessage exige v=1 e type", () => {
    expect(parseServerMessage('{"v":1,"type":"session.ended","sessionId":"s","reason":"stopped"}')).toEqual({
      v: 1,
      type: "session.ended",
      sessionId: "s",
      reason: "stopped",
    });
    expect(parseServerMessage('{"v":2,"type":"x"}')).toBeNull();
    expect(parseServerMessage("[]")).toBeNull();
    expect(parseServerMessage("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test packages/shared/src/messages.test.ts`
Expected: FAIL — `Failed to resolve import "./messages"`.

- [ ] **Step 3: Implementar as mensagens**

Criar `packages/shared/src/messages.ts`:

```ts
import { z } from "zod";
import type { Channel } from "./audio-frame";

export const MODES = ["work", "sales", "interview", "relationship"] as const;
export type Mode = (typeof MODES)[number];
export const MAX_CONTEXT_CHARS = 2_000;

export const CLOSE_CODES = {
  protocolError: 4400,
  unauthorized: 4401,
  sessionNotFound: 4404,
  superseded: 4409,
  sessionEnded: 4410,
} as const;

const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("session.start"),
    token: z.string().min(1),
    mode: z.enum(MODES),
    context: z.string().max(MAX_CONTEXT_CHARS),
  }),
  z.object({ type: z.literal("session.stop") }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = clientMessageSchema.safeParse(data);
  return result.success ? result.data : null;
}

export type SessionEndReason = "stopped" | "replaced" | "expired" | "max_duration" | "error";

export type ServerControl =
  | { v: 1; type: "session.started"; sessionId: string; resumeToken: string }
  | { v: 1; type: "session.ended"; sessionId: string; reason: SessionEndReason };

export interface EventEnvelope {
  v: 1;
  sessionId: string;
  seq: number;
  ts: number;
  channel?: Channel;
  utteranceId?: string;
}

export type ServerEventBody = { type: "transcript.partial"; channel: Channel; text: string };

export type ServerEvent = EventEnvelope & ServerEventBody;

export type ServerMessage = ServerControl | ServerEvent;

export function isServerEvent(message: ServerMessage): message is ServerEvent {
  return "seq" in message;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const candidate = data as { v?: unknown; type?: unknown };
  return candidate.v === 1 && typeof candidate.type === "string" ? (data as ServerMessage) : null;
}
```

Modificar `packages/shared/src/index.ts`:

```ts
export * from "./audio-frame";
export * from "./messages";
```

- [ ] **Step 4: Rodar os testes e o typecheck**

Run: `pnpm test packages/shared && pnpm --filter @snowspeak/shared typecheck`
Expected: PASS (12 testes) e typecheck sem erros.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): mensagens do protocolo e códigos de fechamento"
```

---

### Task 3: Servidor com autenticação, validação de frames e STT falso

**Files:**
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/.env.example`
- Create: `apps/server/src/config.ts`, `apps/server/src/stt/types.ts`, `apps/server/src/stt/fake-stt.ts`, `apps/server/src/session.ts`, `apps/server/src/gateway.ts`, `apps/server/src/main.ts`
- Test: `apps/server/src/config.test.ts`, `apps/server/src/stt/fake-stt.test.ts`, `apps/server/src/gateway.test.ts`

**Interfaces:**
- Consumes: `decodeFrame`, `AudioFrame`, `Channel`, `SAMPLE_RATE`, `parseClientMessage`, `CLOSE_CODES`, `ServerMessage`, `ServerEventBody`, `Mode` (Tasks 1–2).
- Produces:
  - `interface ServerConfig { port: number; host: string; accessKeys: Set<string>; allowedOrigins: Set<string>; authTimeoutMs: number }`, `loadConfig(env?: NodeJS.ProcessEnv): ServerConfig`
  - `type SttResult = { kind: "partial"; text: string }`, `interface SttStream { write(pcm: Uint8Array): void; close(): void }`, `type SttFactory = (channel: Channel, onResult: (result: SttResult) => void) => SttStream`
  - `createFakeSttFactory(options?: { reportEveryMs?: number }): SttFactory`
  - `class Session` (id, resumeToken, `acceptFrame(frame)`, `close()`)
  - `startGateway(config: ServerConfig, deps: { sttFactory: SttFactory }): Promise<Gateway>` com `interface Gateway { url: string; close(): Promise<void> }`

- [ ] **Step 1: Criar o pacote do servidor**

Criar `apps/server/package.json`:

```json
{
  "name": "@snowspeak/server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "node --env-file=.env --watch --import tsx src/main.ts",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

Criar `apps/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": ["node"] },
  "include": ["src"]
}
```

Criar `apps/server/.env.example`:

```
PORT=8787
HOST=0.0.0.0
# chaves de acesso separadas por vírgula
ACCESS_KEYS=dev-key-troque-isto
# origem da extensão (veja o ID em chrome://extensions)
ALLOWED_ORIGINS=chrome-extension://COLE_O_ID_DA_EXTENSAO_AQUI
```

Instalar dependências:

```bash
pnpm --filter @snowspeak/server add ws "@snowspeak/shared@workspace:*"
pnpm --filter @snowspeak/server add -D tsx @types/ws
```

- [ ] **Step 2: Escrever os testes de configuração e do STT falso**

Criar `apps/server/src/config.test.ts`:

```ts
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
```

Criar `apps/server/src/stt/fake-stt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createFakeSttFactory } from "./fake-stt";
import type { SttResult } from "./types";

describe("FakeStt", () => {
  it("emite um parcial a cada segundo de áudio recebido", () => {
    const results: SttResult[] = [];
    const stt = createFakeSttFactory()("them", (r) => results.push(r));
    for (let i = 0; i < 9; i++) stt.write(new Uint8Array(3200));
    expect(results).toHaveLength(0);
    stt.write(new Uint8Array(3200));
    expect(results).toEqual([{ kind: "partial", text: "[fake-stt them] 1.0 s de áudio recebidos" }]);
    for (let i = 0; i < 10; i++) stt.write(new Uint8Array(3200));
    expect(results.at(-1)).toEqual({ kind: "partial", text: "[fake-stt them] 2.0 s de áudio recebidos" });
  });

  it("não emite nada depois de fechado", () => {
    const results: SttResult[] = [];
    const stt = createFakeSttFactory({ reportEveryMs: 100 })("me", (r) => results.push(r));
    stt.close();
    stt.write(new Uint8Array(3200));
    expect(results).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/config.test.ts apps/server/src/stt`
Expected: FAIL — imports `./config` e `./fake-stt` não resolvidos.

- [ ] **Step 4: Implementar configuração e STT falso**

Criar `apps/server/src/config.ts`:

```ts
export interface ServerConfig {
  port: number;
  host: string;
  accessKeys: Set<string>;
  allowedOrigins: Set<string>;
  authTimeoutMs: number;
}

function parseList(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const accessKeys = parseList(env.ACCESS_KEYS);
  if (accessKeys.size === 0) throw new Error("ACCESS_KEYS não configurado");
  const allowedOrigins = parseList(env.ALLOWED_ORIGINS);
  if (allowedOrigins.size === 0) throw new Error("ALLOWED_ORIGINS não configurado");

  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "0.0.0.0",
    accessKeys,
    allowedOrigins,
    authTimeoutMs: 5_000,
  };
}
```

Criar `apps/server/src/stt/types.ts`:

```ts
import type { Channel } from "@snowspeak/shared";

// Ampliado no marco 3 (segmentos estáveis, fim de fala, tempos de palavra).
export type SttResult = { kind: "partial"; text: string };

export interface SttStream {
  write(pcm: Uint8Array): void;
  close(): void;
}

export type SttFactory = (channel: Channel, onResult: (result: SttResult) => void) => SttStream;
```

Criar `apps/server/src/stt/fake-stt.ts`:

```ts
import { SAMPLE_RATE } from "@snowspeak/shared";
import type { SttFactory } from "./types";

// STT falso guiado pelo próprio áudio: prova que os frames chegam sem depender de provedor.
export function createFakeSttFactory(options: { reportEveryMs?: number } = {}): SttFactory {
  const reportEverySamples = ((options.reportEveryMs ?? 1_000) * SAMPLE_RATE) / 1_000;

  return (channel, onResult) => {
    let samples = 0;
    let lastReported = 0;
    let closed = false;

    return {
      write(pcm) {
        if (closed) return;
        samples += pcm.byteLength / 2;
        if (samples - lastReported >= reportEverySamples) {
          lastReported = samples;
          const seconds = (samples / SAMPLE_RATE).toFixed(1);
          onResult({ kind: "partial", text: `[fake-stt ${channel}] ${seconds} s de áudio recebidos` });
        }
      },
      close() {
        closed = true;
      },
    };
  };
}
```

- [ ] **Step 5: Rodar os testes de configuração e STT falso**

Run: `pnpm test apps/server/src/config.test.ts apps/server/src/stt`
Expected: PASS (4 testes).

- [ ] **Step 6: Escrever os testes de integração do gateway**

Criar `apps/server/src/gateway.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { encodeFrame, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { startGateway, type Gateway } from "./gateway";
import { createFakeSttFactory } from "./stt/fake-stt";

const ORIGIN = "chrome-extension://test-extension";
const START = { type: "session.start", token: "key-1", mode: "work", context: "" };

const config: ServerConfig = {
  port: 0,
  host: "127.0.0.1",
  accessKeys: new Set(["key-1"]),
  allowedOrigins: new Set([ORIGIN]),
  authTimeoutMs: 200,
};

class TestClient {
  readonly messages: ServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  private waiters: Array<() => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.closed = new Promise((resolve) => {
      ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
  }

  static async connect(url: string, origin = ORIGIN): Promise<TestClient> {
    const ws = new WebSocket(url, { origin });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  sendJson(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  sendSilence(channel: "them" | "me", frameSeq: number): void {
    this.ws.send(encodeFrame({ channel, frameSeq, sampleOffset: frameSeq * 1600, pcm: new Uint8Array(3200) }));
  }

  async waitFor(predicate: (m: ServerMessage) => boolean, timeoutMs = 2_000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timeout; recebidas: ${JSON.stringify(this.messages)}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

describe("gateway", () => {
  let gateway: Gateway;

  beforeEach(async () => {
    gateway = await startGateway(config, { sttFactory: createFakeSttFactory() });
  });

  afterEach(async () => {
    await gateway.close();
  });

  it("inicia a sessão com chave válida", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    const started = await client.waitFor((m) => m.type === "session.started");
    expect(started).toMatchObject({ v: 1, type: "session.started" });
    if (started.type !== "session.started") throw new Error("tipo inesperado");
    expect(started.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(started.resumeToken.length).toBeGreaterThanOrEqual(43);
  });

  it("fecha com 4401 quando a chave é inválida", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ ...START, token: "errada" });
    expect((await client.closed).code).toBe(4401);
  });

  it("fecha com 4401 quando nenhuma mensagem chega no prazo", async () => {
    const client = await TestClient.connect(gateway.url);
    expect((await client.closed).code).toBe(4401);
  });

  it("fecha com 4401 quando a primeira mensagem não é session.start", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4401);
  });

  it("recusa a conexão de uma origem não permitida", async () => {
    await expect(TestClient.connect(gateway.url, "https://evil.example")).rejects.toThrow(/401/);
  });

  it("fecha com 4400 quando chega áudio antes da sessão", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendSilence("them", 0);
    expect((await client.closed).code).toBe(4400);
  });

  it("encaminha os frames ao STT e devolve eventos com seq", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    await client.waitFor((m) => m.type === "session.started");
    for (let i = 0; i < 10; i++) client.sendSilence("them", i);
    for (let i = 0; i < 10; i++) client.sendSilence("me", i);

    const them = await client.waitFor((m) => m.type === "transcript.partial" && m.channel === "them");
    const me = await client.waitFor((m) => m.type === "transcript.partial" && m.channel === "me");
    expect(them).toMatchObject({ seq: 1, text: "[fake-stt them] 1.0 s de áudio recebidos" });
    expect(me).toMatchObject({ seq: 2, text: "[fake-stt me] 1.0 s de áudio recebidos" });
  });

  it("descarta frame malformado sem fechar a conexão", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    await client.waitFor((m) => m.type === "session.started");

    client.ws.send(new Uint8Array(9 + 3)); // payload ímpar
    client.ws.send(new Uint8Array(9 + 3200 + 2)); // grande demais
    for (let i = 0; i < 10; i++) client.sendSilence("them", i);

    await client.waitFor((m) => m.type === "transcript.partial");
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("session.stop envia session.ended e fecha com 4410", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    await client.waitFor((m) => m.type === "session.started");
    client.sendJson({ type: "session.stop" });
    expect((await client.closed).code).toBe(4410);
    expect(client.messages.at(-1)).toMatchObject({ type: "session.ended", reason: "stopped" });
  });

  it("fecha com 4400 quando a mensagem JSON é inválida", async () => {
    const client = await TestClient.connect(gateway.url);
    client.sendJson(START);
    await client.waitFor((m) => m.type === "session.started");
    client.ws.send("{quebrado");
    expect((await client.closed).code).toBe(4400);
  });
});
```

- [ ] **Step 7: Rodar e confirmar a falha**

Run: `pnpm test apps/server/src/gateway.test.ts`
Expected: FAIL — `Failed to resolve import "./gateway"`.

- [ ] **Step 8: Implementar sessão, gateway e ponto de entrada**

Criar `apps/server/src/session.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import type { AudioFrame, Channel, Mode, ServerEventBody, ServerMessage } from "@snowspeak/shared";
import type { SttFactory, SttResult, SttStream } from "./stt/types";

export interface SessionDeps {
  sttFactory: SttFactory;
  send: (message: ServerMessage) => void;
  now?: () => number;
}

export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private readonly stt: Record<Channel, SttStream>;

  constructor(
    private readonly deps: SessionDeps,
    readonly mode: Mode,
    readonly context: string,
  ) {
    this.stt = {
      them: deps.sttFactory("them", (result) => this.onSttResult("them", result)),
      me: deps.sttFactory("me", (result) => this.onSttResult("me", result)),
    };
  }

  acceptFrame(frame: AudioFrame): void {
    this.stt[frame.channel].write(frame.pcm);
  }

  close(): void {
    this.stt.them.close();
    this.stt.me.close();
  }

  private onSttResult(channel: Channel, result: SttResult): void {
    this.emit({ type: "transcript.partial", channel, text: result.text });
  }

  private emit(body: ServerEventBody): void {
    this.seq += 1;
    this.deps.send({ v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body });
  }
}
```

Criar `apps/server/src/gateway.ts`:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CLOSE_CODES, decodeFrame, parseClientMessage, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { Session } from "./session";
import type { SttFactory } from "./stt/types";

export interface GatewayDeps {
  sttFactory: SttFactory;
}

export interface Gateway {
  url: string;
  close(): Promise<void>;
}

export async function startGateway(config: ServerConfig, deps: GatewayDeps): Promise<Gateway> {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200).end("ok");
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: 64 * 1024,
    verifyClient: (info: { origin: string }) => config.allowedOrigins.has(info.origin),
  });
  wss.on("connection", (ws) => handleConnection(ws, config, deps));

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function handleConnection(ws: WebSocket, config: ServerConfig, deps: GatewayDeps): void {
  let session: Session | null = null;
  let invalidFrames = 0;

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const authTimer = setTimeout(() => ws.close(CLOSE_CODES.unauthorized, "auth timeout"), config.authTimeoutMs);

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session) {
        ws.close(CLOSE_CODES.protocolError, "audio before session");
        return;
      }
      const decoded = decodeFrame(toBytes(data));
      if (!decoded.ok) {
        invalidFrames += 1;
        return;
      }
      session.acceptFrame(decoded.frame);
      return;
    }

    const message = parseClientMessage(data.toString());
    if (!session) {
      if (message?.type !== "session.start") {
        ws.close(CLOSE_CODES.unauthorized, "session.start required");
        return;
      }
      if (!config.accessKeys.has(message.token)) {
        ws.close(CLOSE_CODES.unauthorized, "invalid token");
        return;
      }
      clearTimeout(authTimer);
      session = new Session({ sttFactory: deps.sttFactory, send }, message.mode, message.context);
      send({ v: 1, type: "session.started", sessionId: session.id, resumeToken: session.resumeToken });
      return;
    }

    if (message?.type === "session.stop") {
      send({ v: 1, type: "session.ended", sessionId: session.id, reason: "stopped" });
      session.close();
      session = null;
      ws.close(CLOSE_CODES.sessionEnded, "stopped");
      return;
    }

    ws.close(CLOSE_CODES.protocolError, "invalid message");
  });

  ws.on("close", () => {
    clearTimeout(authTimer);
    session?.close();
    if (invalidFrames > 0) console.warn(`conexão encerrada com ${invalidFrames} frames inválidos descartados`);
  });
}
```

Criar `apps/server/src/main.ts`:

```ts
import { loadConfig } from "./config";
import { startGateway } from "./gateway";
import { createFakeSttFactory } from "./stt/fake-stt";

const config = loadConfig();
const gateway = await startGateway(config, { sttFactory: createFakeSttFactory() });
console.log(`SnowSpeak server ouvindo em ${config.host}:${config.port} (ws em /ws)`);

const shutdown = (): void => {
  void gateway.close().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

- [ ] **Step 9: Rodar todos os testes do servidor e o typecheck**

Run: `pnpm test apps/server && pnpm --filter @snowspeak/server typecheck`
Expected: PASS (14 testes) e typecheck sem erros.

- [ ] **Step 10: Conferir o servidor rodando**

```bash
cp apps/server/.env.example apps/server/.env
pnpm --filter @snowspeak/server dev &
sleep 2 && curl -s http://127.0.0.1:8787/health; kill %1
```
Expected: `ok`.

- [ ] **Step 11: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "feat(server): gateway WebSocket com autenticação, validação de frames e STT falso"
```

---

### Task 4: Extensão — conversão PCM e envio de frames

**Files:**
- Create: `apps/extension/package.json`, `apps/extension/tsconfig.json`
- Create: `apps/extension/src/audio/pcm.ts`, `apps/extension/src/offscreen/frame-sender.ts`
- Test: `apps/extension/src/audio/pcm.test.ts`, `apps/extension/src/offscreen/frame-sender.test.ts`

**Interfaces:**
- Consumes: `encodeFrame`, `decodeFrame`, `Channel`, `AudioFrame` (Task 1).
- Produces:
  - `FRAME_SAMPLES = 1600`, `floatTo16BitPcm(input: Float32Array): Int16Array`, `rms(input: Float32Array): number`
  - `class FrameAccumulator { constructor(onFrame: (pcm: Int16Array) => void); push(samples: Int16Array): void; flush(): void }` — cada array entregue é novo (pode ser transferido).
  - `MAX_BUFFERED_BYTES = 32 * 1024`
  - `interface FrameSink { readonly bufferedAmount: number; readonly isOpen: boolean; send(data: ArrayBuffer): void }`
  - `interface ChannelStats { sentFrames: number; droppedFrames: number }`
  - `class FrameSender { constructor(sink: FrameSink); push(channel: Channel, pcm: ArrayBuffer): void; stats(): Record<Channel, ChannelStats> }`

- [ ] **Step 1: Criar o pacote da extensão**

Criar `apps/extension/package.json`:

```json
{
  "name": "@snowspeak/extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "typecheck": "tsc -p tsconfig.json"
  }
}
```

Criar `apps/extension/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
```

Instalar dependências:

```bash
pnpm --filter @snowspeak/extension add "@snowspeak/shared@workspace:*"
pnpm --filter @snowspeak/extension add -D vite @types/chrome
```

- [ ] **Step 2: Escrever os testes**

Criar `apps/extension/src/audio/pcm.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FRAME_SAMPLES, FrameAccumulator, floatTo16BitPcm, rms } from "./pcm";

describe("floatTo16BitPcm", () => {
  it("converte e limita ao intervalo de 16 bits", () => {
    const out = floatTo16BitPcm(new Float32Array([0, 1, -1, 1.5, -2, 0.5]));
    expect(Array.from(out)).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe("rms", () => {
  it("calcula a raiz média quadrática e trata bloco vazio", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe("FrameAccumulator", () => {
  it("junta blocos de 128 samples em frames de 1600", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    for (let i = 0; i < 25; i++) acc.push(new Int16Array(128).fill(i)); // 3200 samples
    expect(frames.map((f) => f.length)).toEqual([FRAME_SAMPLES, FRAME_SAMPLES]);
    expect(frames[0]?.[0]).toBe(0);
    expect(frames[1]?.[0]).toBe(12); // o bloco 12 começa no sample 1536; o sample 1600 pertence a ele
  });

  it("entrega arrays novos a cada frame", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    acc.push(new Int16Array(FRAME_SAMPLES * 2));
    expect(frames[0]).not.toBe(frames[1]);
    expect(frames[0]?.buffer).not.toBe(frames[1]?.buffer);
  });

  it("flush entrega o restante e não entrega nada quando vazio", () => {
    const frames: Int16Array[] = [];
    const acc = new FrameAccumulator((pcm) => frames.push(pcm));
    acc.push(new Int16Array(400));
    acc.flush();
    acc.flush();
    expect(frames.map((f) => f.length)).toEqual([400]);
    expect(frames[0]?.buffer.byteLength).toBe(800);
  });
});
```

Criar `apps/extension/src/offscreen/frame-sender.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeFrame, type AudioFrame } from "@snowspeak/shared";
import { FrameSender, MAX_BUFFERED_BYTES, type FrameSink } from "./frame-sender";

class FakeSink implements FrameSink {
  bufferedAmount = 0;
  isOpen = true;
  readonly frames: AudioFrame[] = [];
  send(data: ArrayBuffer): void {
    const decoded = decodeFrame(new Uint8Array(data));
    if (!decoded.ok) throw new Error(decoded.reason);
    this.frames.push(decoded.frame);
  }
}

const fullFrame = (): ArrayBuffer => new ArrayBuffer(3200);

describe("FrameSender", () => {
  it("numera frameSeq e sampleOffset de forma independente por canal", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sender.push("them", fullFrame());
    sender.push("them", fullFrame());
    sender.push("me", fullFrame());
    expect(sink.frames.map((f) => [f.channel, f.frameSeq, f.sampleOffset])).toEqual([
      ["them", 0, 0],
      ["them", 1, 1600],
      ["me", 0, 0],
    ]);
  });

  it("descarta quando o socket está congestionado, mas avança os contadores", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sink.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    sender.push("them", fullFrame());
    sink.bufferedAmount = MAX_BUFFERED_BYTES;
    sender.push("them", fullFrame());
    expect(sink.frames.map((f) => [f.frameSeq, f.sampleOffset])).toEqual([[1, 1600]]);
    expect(sender.stats().them).toEqual({ sentFrames: 1, droppedFrames: 1 });
  });

  it("descarta quando o socket não está aberto", () => {
    const sink = new FakeSink();
    sink.isOpen = false;
    const sender = new FrameSender(sink);
    sender.push("me", fullFrame());
    expect(sink.frames).toHaveLength(0);
    expect(sender.stats().me).toEqual({ sentFrames: 0, droppedFrames: 1 });
  });

  it("avança sampleOffset pelo tamanho real de um frame curto", () => {
    const sink = new FakeSink();
    const sender = new FrameSender(sink);
    sender.push("them", new ArrayBuffer(800));
    sender.push("them", fullFrame());
    expect(sink.frames[1]?.sampleOffset).toBe(400);
  });
});
```

- [ ] **Step 3: Rodar e confirmar a falha**

Run: `pnpm test apps/extension`
Expected: FAIL — `./pcm` e `./frame-sender` não resolvidos.

- [ ] **Step 4: Implementar**

Criar `apps/extension/src/audio/pcm.ts`:

```ts
export const FRAME_SAMPLES = 1_600; // 100 ms a 16 kHz

export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function rms(input: Float32Array): number {
  if (input.length === 0) return 0;
  let sum = 0;
  for (const s of input) sum += s * s;
  return Math.sqrt(sum / input.length);
}

// Junta os blocos de 128 samples do AudioWorklet em frames de 100 ms.
// Cada frame entregue usa um buffer novo, então pode ser transferido via postMessage.
export class FrameAccumulator {
  private buffer = new Int16Array(FRAME_SAMPLES);
  private filled = 0;

  constructor(private readonly onFrame: (pcm: Int16Array) => void) {}

  push(samples: Int16Array): void {
    let offset = 0;
    while (offset < samples.length) {
      const count = Math.min(FRAME_SAMPLES - this.filled, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + count), this.filled);
      this.filled += count;
      offset += count;
      if (this.filled === FRAME_SAMPLES) {
        this.onFrame(this.buffer);
        this.buffer = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }
    }
  }

  flush(): void {
    if (this.filled === 0) return;
    this.onFrame(this.buffer.slice(0, this.filled));
    this.buffer = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }
}
```

Criar `apps/extension/src/offscreen/frame-sender.ts`:

```ts
import { encodeFrame, type Channel } from "@snowspeak/shared";

// ~0,5 s de áudio dos dois canais; acima disso o frame é descartado em vez de enfileirado.
export const MAX_BUFFERED_BYTES = 32 * 1024;

export interface FrameSink {
  readonly bufferedAmount: number;
  readonly isOpen: boolean;
  send(data: ArrayBuffer): void;
}

export interface ChannelStats {
  sentFrames: number;
  droppedFrames: number;
}

interface ChannelCounters extends ChannelStats {
  frameSeq: number;
  sampleOffset: number;
}

function freshCounters(): ChannelCounters {
  return { frameSeq: 0, sampleOffset: 0, sentFrames: 0, droppedFrames: 0 };
}

export class FrameSender {
  private readonly counters: Record<Channel, ChannelCounters> = { them: freshCounters(), me: freshCounters() };

  constructor(private readonly sink: FrameSink) {}

  push(channel: Channel, pcm: ArrayBuffer): void {
    const counters = this.counters[channel];
    if (this.sink.isOpen && this.sink.bufferedAmount <= MAX_BUFFERED_BYTES) {
      this.sink.send(
        encodeFrame({ channel, frameSeq: counters.frameSeq, sampleOffset: counters.sampleOffset, pcm: new Uint8Array(pcm) }),
      );
      counters.sentFrames += 1;
    } else {
      counters.droppedFrames += 1;
    }
    // Os contadores avançam mesmo no descarte: o servidor mede a lacuna pelo sampleOffset.
    counters.frameSeq += 1;
    counters.sampleOffset += pcm.byteLength / 2;
  }

  stats(): Record<Channel, ChannelStats> {
    const pick = ({ sentFrames, droppedFrames }: ChannelCounters): ChannelStats => ({ sentFrames, droppedFrames });
    return { them: pick(this.counters.them), me: pick(this.counters.me) };
  }
}
```

- [ ] **Step 5: Rodar os testes**

Run: `pnpm test apps/extension`
Expected: PASS (9 testes).

- [ ] **Step 6: Commit**

```bash
git add apps/extension pnpm-lock.yaml
git commit -m "feat(extension): conversão PCM, acumulador de frames e envio com descarte"
```

---

### Task 5: Extensão — store da sessão

**Files:**
- Create: `apps/extension/src/offscreen/session-store.ts`
- Test: `apps/extension/src/offscreen/session-store.test.ts`

**Interfaces:**
- Consumes: `Channel`, `ServerMessage`, `isServerEvent` (Tasks 1–2); `ChannelStats` (Task 4).
- Produces:
  - `type SessionStatus = "idle" | "starting" | "running" | "error"`, `type MicStatus = "unknown" | "active" | "denied"`
  - `interface ChannelView { level: number; sentFrames: number; droppedFrames: number; lastPartial: string }`
  - `interface SessionState { status; errorMessage: string | null; sessionId: string | null; mic: MicStatus; lastSeq: number; channels: Record<Channel, ChannelView> }`
  - `type StoreAction = { type: "starting" } | { type: "mic"; status: MicStatus } | { type: "level"; channel: Channel; rms: number } | { type: "stats"; stats: Record<Channel, ChannelStats> } | { type: "server"; message: ServerMessage } | { type: "failed"; message: string } | { type: "stopped" }`
  - `initialState(): SessionState`, `reduce(state, action): SessionState`
  - `class SessionStore { dispatch(action): void; snapshot(): SessionState; subscribe(listener: (state: SessionState) => void): () => void }`

- [ ] **Step 1: Escrever os testes**

Criar `apps/extension/src/offscreen/session-store.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import { SessionStore, initialState, reduce, type SessionState, type StoreAction } from "./session-store";

const started: ServerMessage = { v: 1, type: "session.started", sessionId: "s1", resumeToken: "r1" };
const partial = (seq: number, text: string): ServerMessage => ({
  v: 1,
  type: "transcript.partial",
  sessionId: "s1",
  seq,
  ts: 0,
  channel: "them",
  text,
});

function run(...actions: StoreAction[]): SessionState {
  return actions.reduce(reduce, initialState());
}

describe("reduce", () => {
  it("vai de starting para running com o sessionId", () => {
    const state = run({ type: "starting" }, { type: "server", message: started });
    expect(state.status).toBe("running");
    expect(state.sessionId).toBe("s1");
  });

  it("aplica o texto parcial e ignora eventos com seq repetido ou antigo", () => {
    const state = run(
      { type: "starting" },
      { type: "server", message: started },
      { type: "server", message: partial(1, "um") },
      { type: "server", message: partial(2, "dois") },
      { type: "server", message: partial(2, "repetido") },
      { type: "server", message: partial(1, "antigo") },
    );
    expect(state.channels.them.lastPartial).toBe("dois");
    expect(state.lastSeq).toBe(2);
  });

  it("registra microfone negado", () => {
    expect(run({ type: "mic", status: "denied" }).mic).toBe("denied");
  });

  it("registra nível e estatísticas por canal", () => {
    const state = run(
      { type: "level", channel: "me", rms: 0.3 },
      { type: "stats", stats: { them: { sentFrames: 5, droppedFrames: 1 }, me: { sentFrames: 4, droppedFrames: 0 } } },
    );
    expect(state.channels.me).toMatchObject({ level: 0.3, sentFrames: 4, droppedFrames: 0 });
    expect(state.channels.them).toMatchObject({ sentFrames: 5, droppedFrames: 1 });
  });

  it("failed mostra o erro e zera os níveis; starting limpa o erro anterior", () => {
    const failed = run({ type: "level", channel: "them", rms: 0.8 }, { type: "failed", message: "Chave de acesso inválida." });
    expect(failed.status).toBe("error");
    expect(failed.errorMessage).toBe("Chave de acesso inválida.");
    expect(failed.channels.them.level).toBe(0);

    const restarted = reduce(failed, { type: "starting" });
    expect(restarted.errorMessage).toBeNull();
    expect(restarted.status).toBe("starting");
  });

  it("session.ended e stopped levam ao estado parado mantendo o último texto", () => {
    const ended = run(
      { type: "starting" },
      { type: "server", message: started },
      { type: "server", message: partial(1, "último") },
      { type: "server", message: { v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" } },
    );
    expect(ended.status).toBe("idle");
    expect(ended.channels.them.lastPartial).toBe("último");
    expect(reduce(ended, { type: "stopped" }).status).toBe("idle");
  });
});

describe("SessionStore", () => {
  it("snapshot devolve o estado atual para um painel reaberto", () => {
    const store = new SessionStore();
    store.dispatch({ type: "starting" });
    store.dispatch({ type: "server", message: started });
    store.dispatch({ type: "server", message: partial(1, "olá") });
    expect(store.snapshot()).toMatchObject({ status: "running", channels: { them: { lastPartial: "olá" } } });
  });

  it("notifica assinantes e permite cancelar a assinatura", () => {
    const store = new SessionStore();
    const seen: string[] = [];
    const unsubscribe = store.subscribe((state) => seen.push(state.status));
    store.dispatch({ type: "starting" });
    unsubscribe();
    store.dispatch({ type: "stopped" });
    expect(seen).toEqual(["starting"]);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/extension/src/offscreen/session-store.test.ts`
Expected: FAIL — `./session-store` não resolvido.

- [ ] **Step 3: Implementar**

Criar `apps/extension/src/offscreen/session-store.ts`:

```ts
import { isServerEvent, type Channel, type ServerMessage } from "@snowspeak/shared";
import type { ChannelStats } from "./frame-sender";

export type SessionStatus = "idle" | "starting" | "running" | "error";
export type MicStatus = "unknown" | "active" | "denied";

export interface ChannelView {
  level: number;
  sentFrames: number;
  droppedFrames: number;
  lastPartial: string;
}

export interface SessionState {
  status: SessionStatus;
  errorMessage: string | null;
  sessionId: string | null;
  mic: MicStatus;
  lastSeq: number;
  channels: Record<Channel, ChannelView>;
}

export type StoreAction =
  | { type: "starting" }
  | { type: "mic"; status: MicStatus }
  | { type: "level"; channel: Channel; rms: number }
  | { type: "stats"; stats: Record<Channel, ChannelStats> }
  | { type: "server"; message: ServerMessage }
  | { type: "failed"; message: string }
  | { type: "stopped" };

function emptyChannel(): ChannelView {
  return { level: 0, sentFrames: 0, droppedFrames: 0, lastPartial: "" };
}

export function initialState(): SessionState {
  return {
    status: "idle",
    errorMessage: null,
    sessionId: null,
    mic: "unknown",
    lastSeq: 0,
    channels: { them: emptyChannel(), me: emptyChannel() },
  };
}

function withChannel(state: SessionState, channel: Channel, patch: Partial<ChannelView>): SessionState {
  return { ...state, channels: { ...state.channels, [channel]: { ...state.channels[channel], ...patch } } };
}

function silenced(state: SessionState): SessionState["channels"] {
  return { them: { ...state.channels.them, level: 0 }, me: { ...state.channels.me, level: 0 } };
}

function applyServerMessage(state: SessionState, message: ServerMessage): SessionState {
  if (!isServerEvent(message)) {
    switch (message.type) {
      case "session.started":
        return { ...state, status: "running", sessionId: message.sessionId, lastSeq: 0 };
      case "session.ended":
        return { ...state, status: "idle", channels: silenced(state) };
    }
  }
  if (message.seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: message.seq };
  switch (message.type) {
    case "transcript.partial":
      return withChannel(next, message.channel, { lastPartial: message.text });
  }
}

export function reduce(state: SessionState, action: StoreAction): SessionState {
  switch (action.type) {
    case "starting":
      return { ...initialState(), status: "starting" };
    case "mic":
      return { ...state, mic: action.status };
    case "level":
      return withChannel(state, action.channel, { level: action.rms });
    case "stats":
      return {
        ...state,
        channels: {
          them: { ...state.channels.them, ...action.stats.them },
          me: { ...state.channels.me, ...action.stats.me },
        },
      };
    case "server":
      return applyServerMessage(state, action.message);
    case "failed":
      return { ...state, status: "error", errorMessage: action.message, channels: silenced(state) };
    case "stopped":
      return { ...state, status: "idle", channels: silenced(state) };
  }
}

export class SessionStore {
  private state = initialState();
  private readonly listeners = new Set<(state: SessionState) => void>();

  dispatch(action: StoreAction): void {
    this.state = reduce(this.state, action);
    for (const listener of this.listeners) listener(this.state);
  }

  snapshot(): SessionState {
    return this.state;
  }

  subscribe(listener: (state: SessionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 4: Rodar os testes**

Run: `pnpm test apps/extension`
Expected: PASS (17 testes).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/offscreen/session-store.ts apps/extension/src/offscreen/session-store.test.ts
git commit -m "feat(extension): store da sessão com reducer puro e snapshot"
```

---

### Task 6: Extensão — controlador da sessão

**Files:**
- Create: `apps/extension/src/offscreen/session-controller.ts`
- Test: `apps/extension/src/offscreen/session-controller.test.ts`

**Interfaces:**
- Consumes: `FrameSender`, `FrameSink` (Task 4); `SessionStore` (Task 5); `CLOSE_CODES`, `ClientMessage`, `ServerMessage`, `Mode`, `Channel` (Tasks 1–2).
- Produces:
  - `interface StartParams { streamId: string; serverUrl: string; token: string; mode: Mode; context: string }`
  - `interface ChannelCapture { stop(): void }`
  - `interface CaptureCallbacks { onFrame(channel: Channel, pcm: ArrayBuffer): void; onLevel(channel: Channel, rms: number): void }`
  - `interface SocketHandlers { onOpen(): void; onMessage(message: ServerMessage): void; onClose(code: number, reason: string): void }`
  - `interface ControllerSocket extends FrameSink { sendJson(message: ClientMessage): void; close(): void }`
  - `interface ControllerDeps { store: SessionStore; captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture>; captureMic(cb: CaptureCallbacks): Promise<ChannelCapture>; openSocket(url: string, handlers: SocketHandlers): ControllerSocket }`
  - `STATS_INTERVAL_MS = 500`
  - `class SessionController { constructor(deps: ControllerDeps); start(params: StartParams): Promise<void>; stop(): void }`

- [ ] **Step 1: Escrever os testes**

Criar `apps/extension/src/offscreen/session-controller.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFrame, type Channel, type ClientMessage, type ServerMessage } from "@snowspeak/shared";
import {
  STATS_INTERVAL_MS,
  SessionController,
  type CaptureCallbacks,
  type ChannelCapture,
  type ControllerDeps,
  type ControllerSocket,
  type SocketHandlers,
  type StartParams,
} from "./session-controller";
import { SessionStore } from "./session-store";

class FakeSocket implements ControllerSocket {
  bufferedAmount = 0;
  isOpen = false;
  closed = false;
  readonly binary: ArrayBuffer[] = [];
  readonly json: ClientMessage[] = [];

  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers,
  ) {}

  send(data: ArrayBuffer): void {
    this.binary.push(data);
  }
  sendJson(message: ClientMessage): void {
    if (this.isOpen) this.json.push(message);
  }
  close(): void {
    this.closed = true;
    this.isOpen = false;
  }
  open(): void {
    this.isOpen = true;
    this.handlers.onOpen();
  }
  receive(message: ServerMessage): void {
    this.handlers.onMessage(message);
  }
  serverClose(code: number, reason = ""): void {
    this.isOpen = false;
    this.handlers.onClose(code, reason);
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

const params: StartParams = { streamId: "stream-1", serverUrl: "ws://server/ws", token: "key-1", mode: "work", context: "" };
const started: ServerMessage = { v: 1, type: "session.started", sessionId: "s1", resumeToken: "r1" };

function setup(overrides: { tab?: () => Promise<ChannelCapture>; mic?: () => Promise<ChannelCapture> } = {}) {
  const store = new SessionStore();
  const sockets: FakeSocket[] = [];
  const tab = fakeCapture();
  const mic = fakeCapture();
  let callbacks: CaptureCallbacks | null = null;

  const deps: ControllerDeps = {
    store,
    captureTab: vi.fn((_streamId: string, cb: CaptureCallbacks) => {
      callbacks = cb;
      return overrides.tab ? overrides.tab() : Promise.resolve(tab);
    }),
    captureMic: vi.fn(() => (overrides.mic ? overrides.mic() : Promise.resolve(mic))),
    openSocket: (url, handlers) => {
      const socket = new FakeSocket(url, handlers);
      sockets.push(socket);
      return socket;
    },
  };

  return {
    controller: new SessionController(deps),
    deps,
    store,
    sockets,
    tab,
    mic,
    emitFrame(channel: Channel) {
      callbacks?.onFrame(channel, new ArrayBuffer(3200));
    },
  };
}

describe("SessionController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("abre o socket e envia session.start depois de capturar aba e microfone", async () => {
    const t = setup();
    await t.controller.start(params);
    expect(t.deps.captureTab).toHaveBeenCalledWith("stream-1", expect.anything());
    expect(t.sockets).toHaveLength(1);
    t.sockets[0]!.open();
    expect(t.sockets[0]!.json).toEqual([{ type: "session.start", token: "key-1", mode: "work", context: "" }]);
    t.sockets[0]!.receive(started);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "active" });
  });

  it("só envia frames depois de session.started", async () => {
    const t = setup();
    await t.controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    t.emitFrame("them");
    expect(socket.binary).toHaveLength(0);

    socket.receive(started);
    t.emitFrame("them");
    expect(socket.binary).toHaveLength(1);
    const decoded = decodeFrame(new Uint8Array(socket.binary[0]!));
    expect(decoded.ok && [decoded.frame.channel, decoded.frame.frameSeq, decoded.frame.sampleOffset]).toEqual(["them", 0, 0]);
  });

  it("segue só com a aba quando o microfone é negado", async () => {
    const t = setup({ mic: () => Promise.reject(new DOMException("denied", "NotAllowedError")) });
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.receive(started);
    expect(t.store.snapshot()).toMatchObject({ status: "running", mic: "denied" });
  });

  it("falha sem abrir socket quando a captura da aba falha", async () => {
    const t = setup({ tab: () => Promise.reject(new Error("Permission dismissed")) });
    await t.controller.start(params);
    expect(t.sockets).toHaveLength(0);
    expect(t.deps.captureMic).not.toHaveBeenCalled();
    expect(t.store.snapshot().status).toBe("error");
    expect(t.store.snapshot().errorMessage).toBe("Não foi possível capturar o áudio da aba: Permission dismissed");
  });

  it("ignora um segundo start enquanto o primeiro está em andamento", async () => {
    const t = setup();
    const first = t.controller.start(params);
    await t.controller.start(params);
    await first;
    expect(t.deps.captureTab).toHaveBeenCalledTimes(1);
    expect(t.sockets).toHaveLength(1);
  });

  it("mostra erro de conexão e libera capturas quando o servidor não aceita a conexão", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.serverClose(1006);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: "Não foi possível conectar ao servidor." });
    expect(t.tab.stopped).toBe(true);
    expect(t.mic.stopped).toBe(true);
  });

  it("mostra chave inválida no fechamento 4401", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.serverClose(4401, "invalid token");
    expect(t.store.snapshot().errorMessage).toBe("Chave de acesso inválida.");
    expect(t.tab.stopped).toBe(true);
  });

  it("vai para parado quando o servidor encerra a sessão com 4410", async () => {
    const t = setup();
    await t.controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    socket.receive(started);
    socket.receive({ v: 1, type: "session.ended", sessionId: "s1", reason: "stopped" });
    socket.serverClose(4410);
    expect(t.store.snapshot()).toMatchObject({ status: "idle", errorMessage: null });
    expect(t.tab.stopped).toBe(true);
  });

  it("stop envia session.stop, fecha tudo e ignora o fechamento posterior", async () => {
    const t = setup();
    await t.controller.start(params);
    const socket = t.sockets[0]!;
    socket.open();
    socket.receive(started);
    t.controller.stop();
    expect(socket.json.at(-1)).toEqual({ type: "session.stop" });
    expect(socket.closed).toBe(true);
    expect(t.tab.stopped && t.mic.stopped).toBe(true);
    expect(t.store.snapshot().status).toBe("idle");

    socket.serverClose(1006);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("stop durante a captura da aba descarta a captura atrasada", async () => {
    let resolveTab!: (capture: ChannelCapture) => void;
    const t = setup({ tab: () => new Promise((resolve) => (resolveTab = resolve)) });
    const pending = t.controller.start(params);
    t.controller.stop();
    const late = fakeCapture();
    resolveTab(late);
    await pending;
    expect(late.stopped).toBe(true);
    expect(t.sockets).toHaveLength(0);
    expect(t.store.snapshot().status).toBe("idle");
  });

  it("publica estatísticas de frames periodicamente", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.receive(started);
    t.emitFrame("them");
    t.emitFrame("me");
    vi.advanceTimersByTime(STATS_INTERVAL_MS);
    expect(t.store.snapshot().channels.them.sentFrames).toBe(1);
    expect(t.store.snapshot().channels.me.sentFrames).toBe(1);
  });
});
```

- [ ] **Step 2: Rodar e confirmar a falha**

Run: `pnpm test apps/extension/src/offscreen/session-controller.test.ts`
Expected: FAIL — `./session-controller` não resolvido.

- [ ] **Step 3: Implementar**

Criar `apps/extension/src/offscreen/session-controller.ts`:

```ts
import { CLOSE_CODES, type Channel, type ClientMessage, type Mode, type ServerMessage } from "@snowspeak/shared";
import { FrameSender, type FrameSink } from "./frame-sender";
import type { SessionStore } from "./session-store";

export const STATS_INTERVAL_MS = 500;

export interface StartParams {
  streamId: string;
  serverUrl: string;
  token: string;
  mode: Mode;
  context: string;
}

export interface ChannelCapture {
  stop(): void;
}

export interface CaptureCallbacks {
  onFrame(channel: Channel, pcm: ArrayBuffer): void;
  onLevel(channel: Channel, rms: number): void;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(message: ServerMessage): void;
  onClose(code: number, reason: string): void;
}

export interface ControllerSocket extends FrameSink {
  sendJson(message: ClientMessage): void;
  close(): void;
}

export interface ControllerDeps {
  store: SessionStore;
  captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture>;
  captureMic(cb: CaptureCallbacks): Promise<ChannelCapture>;
  openSocket(url: string, handlers: SocketHandlers): ControllerSocket;
}

interface Run {
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  socket: ControllerSocket | null;
  sender: FrameSender | null;
  wasOpen: boolean;
  statsTimer: ReturnType<typeof setInterval> | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeClose(code: number, wasOpen: boolean): string {
  if (!wasOpen) return "Não foi possível conectar ao servidor.";
  if (code === CLOSE_CODES.unauthorized) return "Chave de acesso inválida.";
  return `Conexão com o servidor encerrada (código ${code}).`;
}

export class SessionController {
  private running: Run | null = null;

  constructor(private readonly deps: ControllerDeps) {}

  async start(params: StartParams): Promise<void> {
    if (this.running) return;
    const run: Run = { tab: null, mic: null, socket: null, sender: null, wasOpen: false, statsTimer: null };
    this.running = run;
    this.deps.store.dispatch({ type: "starting" });

    const callbacks: CaptureCallbacks = {
      onFrame: (channel, pcm) => run.sender?.push(channel, pcm),
      onLevel: (channel, rms) => {
        if (this.running === run) this.deps.store.dispatch({ type: "level", channel, rms });
      },
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
      mic = await this.deps.captureMic(callbacks);
    } catch {
      mic = null;
    }
    if (this.running !== run) {
      mic?.stop();
      return;
    }
    run.mic = mic;
    this.deps.store.dispatch({ type: "mic", status: mic ? "active" : "denied" });

    const socket = this.deps.openSocket(params.serverUrl, {
      onOpen: () => {
        run.wasOpen = true;
        socket.sendJson({ type: "session.start", token: params.token, mode: params.mode, context: params.context });
      },
      onMessage: (message) => this.onServerMessage(run, message),
      onClose: (code) => this.onSocketClose(run, code),
    });
    run.socket = socket;
    run.statsTimer = setInterval(() => {
      if (run.sender) this.deps.store.dispatch({ type: "stats", stats: run.sender.stats() });
    }, STATS_INTERVAL_MS);
  }

  stop(): void {
    const run = this.running;
    if (!run) return;
    run.socket?.sendJson({ type: "session.stop" });
    this.release(run);
    this.deps.store.dispatch({ type: "stopped" });
  }

  private onServerMessage(run: Run, message: ServerMessage): void {
    if (this.running !== run) return;
    // Frames só depois de session.started: antes disso o servidor fecharia com 4400.
    if (message.type === "session.started" && run.socket) run.sender = new FrameSender(run.socket);
    this.deps.store.dispatch({ type: "server", message });
  }

  private onSocketClose(run: Run, code: number): void {
    if (this.running !== run) return;
    this.release(run);
    if (code === CLOSE_CODES.sessionEnded) this.deps.store.dispatch({ type: "stopped" });
    else this.deps.store.dispatch({ type: "failed", message: describeClose(code, run.wasOpen) });
  }

  private fail(run: Run, message: string): void {
    this.release(run);
    this.deps.store.dispatch({ type: "failed", message });
  }

  private release(run: Run): void {
    if (this.running === run) this.running = null;
    if (run.statsTimer) clearInterval(run.statsTimer);
    run.statsTimer = null;
    run.tab?.stop();
    run.tab = null;
    run.mic?.stop();
    run.mic = null;
    run.sender = null;
    run.socket?.close();
    run.socket = null;
  }
}
```

- [ ] **Step 4: Rodar os testes e o typecheck**

Run: `pnpm test apps/extension && pnpm --filter @snowspeak/extension typecheck`
Expected: PASS (28 testes) e typecheck sem erros (o `vite.config.ts` do `include` só passa a existir na Task 7; padrões sem arquivo são ignorados).

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/offscreen/session-controller.ts apps/extension/src/offscreen/session-controller.test.ts
git commit -m "feat(extension): controlador da sessão com captura, socket e liberação segura"
```

---

### Task 7: Extensão — integração com o Chrome (manifest, offscreen, worklet, side panel)

**Files:**
- Create: `apps/extension/vite.config.ts`, `apps/extension/public/manifest.json`
- Create: `apps/extension/sidepanel.html`, `apps/extension/offscreen.html`, `apps/extension/permission.html`
- Create: `apps/extension/src/messaging.ts`
- Create: `apps/extension/src/audio/worklet-globals.d.ts`, `apps/extension/src/audio/capture-worklet.ts`
- Create: `apps/extension/src/offscreen/capture.ts`, `apps/extension/src/offscreen/socket.ts`, `apps/extension/src/offscreen/main.ts`
- Create: `apps/extension/src/background/service-worker.ts`
- Create: `apps/extension/src/sidepanel/main.ts`, `apps/extension/src/sidepanel/sidepanel.css`
- Create: `apps/extension/src/permission/main.ts`

**Interfaces:**
- Consumes: `FrameAccumulator`, `floatTo16BitPcm`, `rms` (Task 4); `SessionStore`, `SessionState`, `initialState` (Task 5); `SessionController`, `StartParams`, `CaptureCallbacks`, `ChannelCapture`, `ControllerSocket`, `SocketHandlers` (Task 6); `SAMPLE_RATE`, `parseServerMessage`, `MODES`, `MAX_CONTEXT_CHARS` (Tasks 1–2).
- Produces: extensão empacotada em `apps/extension/dist/`, carregável como "unpacked". Mensagens `chrome.runtime` tipadas em `RuntimeMessage`.

Este passo liga APIs do Chrome que não rodam no Vitest; a verificação é o build + typecheck aqui e o roteiro manual na Task 8.

- [ ] **Step 1: Configurar o build e o manifest**

Criar `apps/extension/vite.config.ts`:

```ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: here("./sidepanel.html"),
        offscreen: here("./offscreen.html"),
        permission: here("./permission.html"),
        "service-worker": here("./src/background/service-worker.ts"),
        "capture-worklet": here("./src/audio/capture-worklet.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
```

Criar `apps/extension/public/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "SnowSpeak",
  "version": "0.1.0",
  "description": "Legendas EN→PT-BR e sugestões de resposta em chamadas.",
  "minimum_chrome_version": "116",
  "permissions": ["tabCapture", "offscreen", "sidePanel", "activeTab", "storage"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "SnowSpeak" }
}
```

- [ ] **Step 2: Mensagens entre contextos**

Criar `apps/extension/src/messaging.ts`:

```ts
import type { StartParams } from "./offscreen/session-controller";
import type { SessionState } from "./offscreen/session-store";

export type BackgroundMessage =
  | { target: "background"; type: "start"; params: StartParams }
  | { target: "background"; type: "stop" };

export type OffscreenMessage =
  | { target: "offscreen"; type: "start"; params: StartParams }
  | { target: "offscreen"; type: "stop" }
  | { target: "offscreen"; type: "get-state" };

export type SidePanelMessage = { target: "sidepanel"; type: "state"; state: SessionState };

export type RuntimeMessage = BackgroundMessage | OffscreenMessage | SidePanelMessage;

export interface StartResponse {
  ok: boolean;
  error?: string;
}
```

- [ ] **Step 3: AudioWorklet**

Criar `apps/extension/src/audio/worklet-globals.d.ts`:

```ts
// Globais do AudioWorkletGlobalScope, ausentes da lib DOM.
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;
```

Criar `apps/extension/src/audio/capture-worklet.ts`:

```ts
import { FrameAccumulator, floatTo16BitPcm, rms } from "./pcm";

const LEVEL_BLOCKS = 25; // 25 blocos × 128 samples ≈ 200 ms a 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  private peakLevel = 0;
  private blocks = 0;
  private readonly accumulator = new FrameAccumulator((pcm) => {
    const buffer = pcm.buffer as ArrayBuffer;
    this.port.postMessage({ type: "frame", pcm: buffer }, [buffer]);
  });

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string }>) => {
      if (event.data.type === "flush") this.accumulator.flush();
    };
  }

  override process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    this.accumulator.push(floatTo16BitPcm(samples));
    this.peakLevel = Math.max(this.peakLevel, rms(samples));
    this.blocks += 1;
    if (this.blocks >= LEVEL_BLOCKS) {
      this.port.postMessage({ type: "level", rms: this.peakLevel });
      this.peakLevel = 0;
      this.blocks = 0;
    }
    return true;
  }
}

registerProcessor("snowspeak-capture", CaptureProcessor);
```

- [ ] **Step 4: Captura e socket no offscreen**

Criar `apps/extension/src/offscreen/capture.ts`:

```ts
import { SAMPLE_RATE, type Channel } from "@snowspeak/shared";
import type { CaptureCallbacks, ChannelCapture } from "./session-controller";

type WorkletMessage = { type: "frame"; pcm: ArrayBuffer } | { type: "level"; rms: number };

async function createCapturePipe(stream: MediaStream, channel: Channel, cb: CaptureCallbacks): Promise<ChannelCapture> {
  // Contexto a 16 kHz: o Chrome reamostra o MediaStream na entrada.
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule(chrome.runtime.getURL("capture-worklet.js"));
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "snowspeak-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  node.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
    const message = event.data;
    if (message.type === "frame") cb.onFrame(channel, message.pcm);
    else cb.onLevel(channel, message.rms);
  };
  // Saída muda até o destino: garante que o grafo seja processado.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(node);
  node.connect(mute);
  mute.connect(context.destination);

  return {
    stop() {
      node.port.onmessage = null;
      source.disconnect();
      void context.close();
    },
  };
}

export async function captureTab(streamId: string, cb: CaptureCallbacks): Promise<ChannelCapture> {
  const constraints = {
    audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    video: false,
  } as unknown as MediaStreamConstraints;
  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  // A captura silencia a aba: devolve o áudio aos alto-falantes num contexto com a taxa nativa.
  const playback = new AudioContext();
  playback.createMediaStreamSource(stream).connect(playback.destination);

  try {
    const pipe = await createCapturePipe(stream, "them", cb);
    return {
      stop() {
        pipe.stop();
        void playback.close();
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (error) {
    void playback.close();
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}

export async function captureMic(cb: CaptureCallbacks): Promise<ChannelCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  try {
    const pipe = await createCapturePipe(stream, "me", cb);
    return {
      stop() {
        pipe.stop();
        for (const track of stream.getTracks()) track.stop();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    throw error;
  }
}
```

Criar `apps/extension/src/offscreen/socket.ts`:

```ts
import { parseServerMessage } from "@snowspeak/shared";
import type { ControllerSocket, SocketHandlers } from "./session-controller";

export function openBrowserSocket(url: string, handlers: SocketHandlers): ControllerSocket {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => handlers.onOpen();
  ws.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const message = parseServerMessage(event.data);
    if (message) handlers.onMessage(message);
  };
  ws.onclose = (event) => handlers.onClose(event.code, event.reason);

  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
    send(data) {
      ws.send(data);
    },
    sendJson(message) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    },
    close() {
      ws.onclose = null;
      ws.close(1000);
    },
  };
}
```

Criar `apps/extension/src/offscreen/main.ts`:

```ts
import type { RuntimeMessage } from "../messaging";
import { captureMic, captureTab } from "./capture";
import { SessionController } from "./session-controller";
import { SessionStore } from "./session-store";
import { openBrowserSocket } from "./socket";

const store = new SessionStore();
const controller = new SessionController({ store, captureTab, captureMic, openSocket: openBrowserSocket });

store.subscribe((state) => {
  const message: RuntimeMessage = { target: "sidepanel", type: "state", state };
  // O painel pode estar fechado; nesse caso não há receptor.
  chrome.runtime.sendMessage(message).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  switch (message.type) {
    case "start":
      void controller.start(message.params);
      break;
    case "stop":
      controller.stop();
      break;
    case "get-state":
      sendResponse(store.snapshot());
      break;
  }
});
```

Criar `apps/extension/offscreen.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>SnowSpeak offscreen</title>
  </head>
  <body>
    <script type="module" src="/src/offscreen/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 5: Service worker**

Criar `apps/extension/src/background/service-worker.ts`:

```ts
import type { RuntimeMessage, StartResponse } from "../messaging";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Capturar o áudio da aba e do microfone para transcrição.",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse: (r: StartResponse) => void) => {
  if (message.target !== "background") return;

  if (message.type === "start") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ target: "offscreen", type: "start", params: message.params } satisfies RuntimeMessage))
      .then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, error: String(error) }),
      );
    return true; // resposta assíncrona
  }

  void chrome.runtime.sendMessage({ target: "offscreen", type: "stop" } satisfies RuntimeMessage).catch(() => undefined);
  return;
});
```

- [ ] **Step 6: Página de permissão do microfone**

O offscreen document não consegue exibir o pedido de permissão; uma aba da própria extensão pede uma vez e a permissão passa a valer para a origem da extensão.

Criar `apps/extension/permission.html`:

```html
<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>SnowSpeak — microfone</title>
    <style>
      body { font: 16px system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
    </style>
  </head>
  <body>
    <h1>Liberar o microfone</h1>
    <p id="status">Aceite o pedido do navegador para o SnowSpeak ouvir as suas falas.</p>
    <script type="module" src="/src/permission/main.ts"></script>
  </body>
</html>
```

Criar `apps/extension/src/permission/main.ts`:

```ts
export {}; // torna o arquivo um módulo (await no nível superior)

const status = document.getElementById("status") as HTMLParagraphElement;

try {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  status.textContent = "Microfone liberado. Esta aba vai fechar sozinha.";
  setTimeout(() => window.close(), 1_000);
} catch {
  status.textContent = "Permissão negada. O SnowSpeak vai funcionar só com o áudio da chamada.";
}
```

- [ ] **Step 7: Side panel**

Criar `apps/extension/sidepanel.html`:

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

    <section class="settings">
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
    </section>

    <div class="actions">
      <button id="start">Iniciar</button>
      <button id="stop" disabled>Parar</button>
    </div>

    <p id="mic-permission" class="notice" hidden>
      O microfone ainda não foi liberado. <button id="grant-mic">Liberar microfone</button>
    </p>
    <p id="local-error" class="error" hidden></p>
    <p id="error" class="error" hidden></p>
    <p id="mic-denied" class="warning" hidden>Sugestões sem suas falas: microfone indisponível.</p>

    <section class="channel" data-channel="them">
      <h2>Participantes</h2>
      <div class="meter"><div class="bar"></div></div>
      <p class="stats"></p>
      <p class="partial"></p>
    </section>

    <section class="channel" data-channel="me">
      <h2>Você</h2>
      <div class="meter"><div class="bar"></div></div>
      <p class="stats"></p>
      <p class="partial"></p>
    </section>

    <script type="module" src="/src/sidepanel/main.ts"></script>
  </body>
</html>
```

Criar `apps/extension/src/sidepanel/sidepanel.css`:

```css
:root {
  color-scheme: dark;
  --bg: #111418;
  --fg: #e8eaed;
  --muted: #9aa0a6;
  --accent: #5ab0ff;
  --error: #ff6b6b;
  --warning: #f4c542;
}

body {
  margin: 0;
  padding: 12px;
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.4 system-ui, sans-serif;
}

header { display: flex; align-items: center; justify-content: space-between; }
h1 { font-size: 18px; margin: 0; }
h2 { font-size: 14px; margin: 0 0 4px; color: var(--muted); }
.status { color: var(--muted); }

.settings { display: grid; gap: 8px; margin: 12px 0; }
.settings label { display: grid; gap: 2px; color: var(--muted); }
input, select, textarea, button { font: inherit; }
input, select, textarea { background: #1c2026; color: var(--fg); border: 1px solid #2c323a; border-radius: 6px; padding: 6px; }

.actions { display: flex; gap: 8px; }
button { background: #1c2026; color: var(--fg); border: 1px solid #2c323a; border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:disabled { opacity: 0.4; cursor: default; }
#start:not(:disabled) { background: var(--accent); color: #0b1a2a; border-color: var(--accent); }

.error { color: var(--error); }
.warning { color: var(--warning); }
.notice { color: var(--muted); }

.channel { margin-top: 16px; }
.meter { height: 6px; background: #1c2026; border-radius: 3px; overflow: hidden; }
.bar { height: 100%; width: 0; background: var(--accent); transition: width 120ms linear; }
.stats { color: var(--muted); font-size: 12px; margin: 4px 0; }
.partial { min-height: 1.4em; margin: 0; }
```

Criar `apps/extension/src/sidepanel/main.ts`:

```ts
import { MAX_CONTEXT_CHARS, MODES, type Mode } from "@snowspeak/shared";
import type { RuntimeMessage, StartResponse } from "../messaging";
import { initialState, type SessionState, type SessionStatus } from "../offscreen/session-store";

const DEFAULT_SETTINGS = { serverUrl: "ws://localhost:8787/ws", token: "", mode: "work" as Mode, context: "" };
type Settings = typeof DEFAULT_SETTINGS;

const STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "Parado",
  starting: "Iniciando…",
  running: "Capturando",
  error: "Erro",
};

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const serverUrlInput = byId<HTMLInputElement>("serverUrl");
const tokenInput = byId<HTMLInputElement>("token");
const modeSelect = byId<HTMLSelectElement>("mode");
const contextInput = byId<HTMLTextAreaElement>("context");
const startButton = byId<HTMLButtonElement>("start");
const stopButton = byId<HTMLButtonElement>("stop");
const statusLabel = byId<HTMLSpanElement>("status");
const errorLabel = byId<HTMLParagraphElement>("error");
const localErrorLabel = byId<HTMLParagraphElement>("local-error");
const micDeniedLabel = byId<HTMLParagraphElement>("mic-denied");
const micPermissionNotice = byId<HTMLParagraphElement>("mic-permission");
const grantMicButton = byId<HTMLButtonElement>("grant-mic");

contextInput.maxLength = MAX_CONTEXT_CHARS;

function render(state: SessionState): void {
  const active = state.status === "starting" || state.status === "running";
  statusLabel.textContent = STATUS_LABELS[state.status];
  startButton.disabled = active;
  stopButton.disabled = !active;
  errorLabel.hidden = !state.errorMessage;
  errorLabel.textContent = state.errorMessage ?? "";
  micDeniedLabel.hidden = !(active && state.mic === "denied");

  for (const channel of ["them", "me"] as const) {
    const view = state.channels[channel];
    const section = document.querySelector<HTMLElement>(`[data-channel="${channel}"]`);
    if (!section) continue;
    (section.querySelector(".bar") as HTMLElement).style.width = `${Math.min(100, view.level * 300)}%`;
    (section.querySelector(".stats") as HTMLElement).textContent =
      `${view.sentFrames} frames enviados · ${view.droppedFrames} descartados`;
    (section.querySelector(".partial") as HTMLElement).textContent = view.lastPartial;
  }
}

function showLocalError(message: string | null): void {
  localErrorLabel.hidden = !message;
  localErrorLabel.textContent = message ?? "";
}

function readForm(): Settings {
  const mode = MODES.includes(modeSelect.value as Mode) ? (modeSelect.value as Mode) : "work";
  return { serverUrl: serverUrlInput.value.trim(), token: tokenInput.value.trim(), mode, context: contextInput.value };
}

async function loadSettings(): Promise<void> {
  const settings = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Settings;
  serverUrlInput.value = settings.serverUrl;
  tokenInput.value = settings.token;
  modeSelect.value = settings.mode;
  contextInput.value = settings.context;
}

async function refreshMicPermission(): Promise<void> {
  try {
    const permission = await navigator.permissions.query({ name: "microphone" as PermissionName });
    micPermissionNotice.hidden = permission.state === "granted";
    permission.onchange = () => {
      micPermissionNotice.hidden = permission.state === "granted";
    };
  } catch {
    micPermissionNotice.hidden = true;
  }
}

startButton.addEventListener("click", async () => {
  showLocalError(null);
  const settings = readForm();
  if (!settings.token) {
    showLocalError("Informe a chave de acesso.");
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) {
    showLocalError("Nenhuma aba ativa para capturar.");
    return;
  }

  let streamId: string;
  try {
    // O streamId expira em poucos segundos: pedir primeiro e usar logo.
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (error) {
    showLocalError(`Não foi possível capturar esta aba: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  const response = (await chrome.runtime.sendMessage({
    target: "background",
    type: "start",
    params: { streamId, ...settings },
  } satisfies RuntimeMessage)) as StartResponse | undefined;
  if (!response?.ok) showLocalError(`Falha ao iniciar: ${response?.error ?? "sem resposta"}`);

  await chrome.storage.local.set(settings);
});

stopButton.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ target: "background", type: "stop" } satisfies RuntimeMessage);
});

grantMicButton.addEventListener("click", () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") });
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message.target === "sidepanel" && message.type === "state") render(message.state);
});

render(initialState());
void loadSettings();
void refreshMicPermission();
// Ao reabrir o painel, reconstrói a tela a partir do offscreen (se existir).
chrome.runtime.sendMessage({ target: "offscreen", type: "get-state" } satisfies RuntimeMessage).then(
  (state: SessionState | undefined) => render(state ?? initialState()),
  () => render(initialState()),
);
```

- [ ] **Step 8: Build, typecheck e testes**

Run: `pnpm --filter @snowspeak/extension typecheck && pnpm --filter @snowspeak/extension build && ls apps/extension/dist`
Expected: typecheck sem erros; build conclui; `dist` contém `manifest.json`, `service-worker.js`, `capture-worklet.js`, `sidepanel.html`, `offscreen.html`, `permission.html`, `assets/`.

Conferir que o worklet não importa chunks (precisa ser autocontido):

Run: `grep -c "import" apps/extension/dist/capture-worklet.js || true`
Expected: `0`.

Run: `pnpm test`
Expected: PASS em todos os pacotes (54 testes).

- [ ] **Step 9: Commit**

```bash
git add apps/extension pnpm-lock.yaml
git commit -m "feat(extension): manifest, offscreen com captura e worklet, service worker e side panel"
```

---

### Task 8: README de desenvolvimento e validação manual no Chrome

**Files:**
- Create: `README.md`
- Modify (somente se o passo de contingência for necessário): `apps/extension/src/background/service-worker.ts`, `apps/extension/src/sidepanel/main.ts`, `apps/extension/src/messaging.ts`

**Interfaces:**
- Consumes: servidor (Task 3) e extensão empacotada (Task 7).
- Produces: roteiro reproduzível de validação e registro do resultado no README.

- [ ] **Step 1: Escrever o README**

Criar `README.md`:

````markdown
# SnowSpeak

Legendas EN→PT-BR em tempo real e sugestões de resposta para chamadas no navegador.

Spec: `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md`

## Requisitos

- Node 20+
- pnpm 9+ (`corepack enable --install-directory ~/.local/bin pnpm`)
- Google Chrome 116+

## Desenvolvimento

```bash
pnpm install
pnpm test
pnpm --filter @snowspeak/extension build
```

1. Abra `chrome://extensions`, ative o **Modo do desenvolvedor**, clique em **Carregar sem compactação** e escolha `apps/extension/dist`.
2. Copie o ID da extensão exibido no card.
3. `cp apps/server/.env.example apps/server/.env` e preencha `ALLOWED_ORIGINS=chrome-extension://<ID>` e uma chave em `ACCESS_KEYS`.
4. `pnpm --filter @snowspeak/server dev`
5. Numa aba com áudio (Meet ou um vídeo do YouTube), clique no ícone do SnowSpeak, informe a chave e clique em **Iniciar**.

Após mudar o código da extensão: `pnpm --filter @snowspeak/extension build` e clique em recarregar no card da extensão.

## Marco 1 — roteiro de validação

Marque cada item ao validar no Chrome:

- [ ] Clique no ícone abre o side panel.
- [ ] "Liberar microfone" abre a aba de permissão; após aceitar, o aviso some do painel.
- [ ] Iniciar numa aba do YouTube tocando: status "Capturando", barra "Participantes" se move.
- [ ] O áudio do vídeo continua audível durante a captura.
- [ ] Falar no microfone move a barra "Você".
- [ ] A cada segundo aparece `[fake-stt them] N s de áudio recebidos` e `[fake-stt me] ...`, com N crescendo.
- [ ] "descartados" permanece 0 em rede local.
- [ ] Fechar e reabrir o painel durante a captura mostra o mesmo status, contadores e textos.
- [ ] Parar: status "Parado", barras zeradas, ícone de captura da aba some.
- [ ] Chave errada: mensagem "Chave de acesso inválida." e nenhuma captura ativa.
- [ ] Servidor desligado: mensagem "Não foi possível conectar ao servidor." e nenhuma captura ativa.
- [ ] Microfone bloqueado (ícone de cadeado da extensão → bloquear): sessão inicia, aviso "Sugestões sem suas falas".
- [ ] Clique duplo rápido em Iniciar: apenas uma captura (contadores não duplicam).
- [ ] Com alto-falantes (sem fone): observar se a barra "Você" reage ao áudio da aba — registrar o resultado para o marco 3 (eco no canal `me`).
- [ ] Repetir o fluxo numa chamada real do Google Meet.
````

- [ ] **Step 2: Executar o roteiro no Chrome**

```bash
pnpm install
pnpm test
pnpm --filter @snowspeak/extension build
cp -n apps/server/.env.example apps/server/.env
```

Carregar a extensão, preencher o `.env` com o ID e rodar `pnpm --filter @snowspeak/server dev`. Percorrer cada item do roteiro do README e marcar `[x]` nos que passarem. Para os que falharem, registrar abaixo do roteiro o sintoma observado.

- [ ] **Step 3 (contingência): se `getMediaStreamId` falhar no side panel**

Sintoma: ao clicar Iniciar aparece "Não foi possível capturar esta aba: Extension has not been invoked for the current page". Nesse caso, o streamId passa a ser obtido pelo service worker no clique do ícone, que conta como invocação.

Em `apps/extension/src/messaging.ts`, trocar o `start` do background para não carregar `streamId`:

```ts
export type BackgroundMessage =
  | { target: "background"; type: "start"; params: Omit<StartParams, "streamId"> }
  | { target: "background"; type: "stop" };
```

Em `apps/extension/src/background/service-worker.ts`, substituir a primeira linha (`setPanelBehavior`) por:

```ts
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });

chrome.action.onClicked.addListener((tab) => {
  if (tab.id === undefined) return;
  void chrome.storage.session.set({ invokedTabId: tab.id });
  void chrome.sidePanel.open({ tabId: tab.id });
});
```

e o ramo `start` por:

```ts
  if (message.type === "start") {
    chrome.storage.session
      .get("invokedTabId")
      .then(async ({ invokedTabId }) => {
        if (typeof invokedTabId !== "number") throw new Error("Clique no ícone do SnowSpeak na aba da chamada.");
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: invokedTabId });
        await ensureOffscreen();
        await chrome.runtime.sendMessage({
          target: "offscreen",
          type: "start",
          params: { ...message.params, streamId },
        } satisfies RuntimeMessage);
      })
      .then(
        () => sendResponse({ ok: true }),
        (error: unknown) => sendResponse({ ok: false, error: String(error) }),
      );
    return true;
  }
```

Em `apps/extension/src/sidepanel/main.ts`, no handler de Iniciar, remover o bloco que consulta `chrome.tabs.query` e chama `getMediaStreamId`, e enviar `params: settings`.

Rodar `pnpm --filter @snowspeak/extension typecheck && pnpm --filter @snowspeak/extension build`, recarregar a extensão e repetir o roteiro.

- [ ] **Step 4: Commit**

```bash
git add README.md apps/extension
git commit -m "docs: README de desenvolvimento e resultado da validação do marco 1"
```
