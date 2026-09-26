# Marco 2 — Reconexão e retomada da sessão: plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uma queda de rede de até 60 s não encerra a chamada: o servidor mantém a sessão, o cliente reconecta sozinho e recebe os eventos que perdeu.

**Architecture:** No servidor, a `Session` deixa de ser dona do socket: guarda um buffer de eventos (sem parciais), pode ser desligada (`detach`) e retomada (`resume`) por outro socket, e um `SessionRegistry` no gateway guarda as sessões vivas, o prazo de 60 s e a regra de uma sessão por chave. No cliente, o `SessionController` trata o fechamento sem código de aplicação como queda: mantém a captura, tenta `session.resume` com backoff e usa o `heartbeat` do servidor para perceber conexões mortas.

**Tech Stack:** TypeScript, Node 20, `ws`, zod (`packages/shared`), Vitest, extensão Chrome MV3 (Vite).

**Spec:** `docs/superpowers/specs/2026-09-26-marco-2-reconexao-design.md` (complementa `docs/superpowers/specs/2026-09-25-snowspeak-realtime-engine-design.md` §5).

## Global Constraints

- Prazo de retomada: **60 s** (`resumeWindowMs = 60_000`) no servidor; o cliente desiste 60 s depois da queda (`RESUME_WINDOW_MS = 60_000`).
- Buffer de eventos: **2.000** eventos, **sem `transcript.partial`**.
- Backoff do cliente: **500, 1.000, 2.000, 4.000, 8.000, 10.000 ms** (depois, sempre 10.000).
- `heartbeat` do servidor a cada **5.000 ms**; o cliente considera a conexão morta depois de **15.000 ms** sem mensagens.
- Ping do WebSocket no servidor a cada **10.000 ms**; socket que não respondeu ao ping anterior é derrubado com `terminate()`.
- Códigos: `4400` protocolo/retomada inválida, `4401` chave, `4404` sessão inexistente/expirada/eventos perdidos, `4409` sessão assumida, `4410` sessão encerrada. Código de aplicação = `4400–4499`.
- Mensagens da UI, exatamente:
  - `"A conexão ficou fora por muito tempo e a sessão foi encerrada."`
  - `"Sessão aberta em outro lugar."`
  - `"Sessão encerrada: foi iniciada em outro lugar."`
  - `"Chave de acesso inválida."` (já existe)
  - status `"Reconectando…"`
- `POST /dev/drop-sockets` só existe com `DEV_ENDPOINTS=1`; sem a variável responde 404.
- Nada de medição de uso, SQLite, snapshot de estado, botão "Usar aqui" ou limite de 4 h.
- Comentários e mensagens em português, no estilo do código existente. Commits no formato `feat(server): …`, `feat(extension): …`, `feat(shared): …`, terminando com a linha `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Comandos de teste, a partir da raiz do repositório: `pnpm test` (tudo) e `pnpm typecheck`. Para um arquivo: `npx vitest run <caminho>`.

## Review Focus

1. **`utteranceId` repetido depois da retomada.** Se o STT reaberto recriar o montador de falas, a próxima fala volta a ser `them-1` e colide com a legenda do cliente. O montador e o divisor de frases têm de sobreviver; só o stream do STT é trocado (teste na Task 3).
2. **Tempos do STT recomeçando do zero.** O stream novo do Deepgram conta o tempo a partir de 0; o `UtteranceEnd` da primeira fala depois da volta não pode ser descartado como "atrasado" (teste na Task 3).
3. **Mensagens enviadas antes do `session.resumed`.** Um `Alt+S` ou uma mudança de currículo durante a tentativa de retomada iria como primeira mensagem do socket e o servidor fecharia com `4401`. O controlador só envia com a sessão viva (teste na Task 7).
4. **Socket antigo ainda aberto no servidor.** Quando a queda é só do lado do cliente, o servidor ainda acha que o socket velho está ligado; a retomada tem de assumir a sessão, e o fechamento posterior do socket velho não pode derrubar nem agendar a expiração da sessão (teste na Task 5).
5. **Eventos gerados durante a drenagem da queda.** O `utterance.end` interrompido e uma sugestão que termina durante a queda chegam ao buffer e têm de aparecer na reposição, sem duplicar o que vier ao vivo depois (testes nas Tasks 4 e 5).

---

## Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `packages/shared/src/messages.ts` | `session.resume`, `session.resumed`, `session.superseded`, `heartbeat` |
| `apps/server/src/event-buffer.ts` (novo) | Buffer circular de eventos para a reposição |
| `apps/server/src/utterance-assembler.ts` | `resetTimeline()` para um stream novo do STT |
| `apps/server/src/channel-pipeline.ts` | `suspend()` e `reopenStt()` |
| `apps/server/src/session.ts` | Dono opcional (`attach`, `detach`, `resume`), buffer, `replayCheck` |
| `apps/server/src/session-registry.ts` (novo) | Sessões vivas, prazo de retomada, uma sessão por chave |
| `apps/server/src/config.ts` | Prazos e `DEV_ENDPOINTS` |
| `apps/server/src/gateway.ts` | `session.resume`, `4409`, `replaced`, heartbeat, ping, `/dev/drop-sockets` |
| `apps/server/src/test-support/test-client.ts` | `testConfig` com os campos novos, `TestClient.lastSeq()` |
| `apps/extension/src/offscreen/session-store.ts` | Status `reconnecting`, `resumeToken`, `session.resumed` |
| `apps/extension/src/offscreen/session-controller.ts` | Reconexão, silêncio do servidor, reação aos códigos |
| `apps/extension/src/sidepanel/main.ts`, `panel-view.ts` | "Reconectando…" e modo captura |
| `README.md`, `apps/server/.env.example` | Roteiro de validação e `DEV_ENDPOINTS` |

---

### Task 1: Protocolo da retomada

**Files:**
- Modify: `packages/shared/src/messages.ts`
- Modify: `apps/extension/src/offscreen/session-store.ts` (só para manter o `switch` exaustivo)
- Test: `packages/shared/src/messages.test.ts`

**Interfaces:**
- Produces:
  - `ClientMessage` ganha `{ type: "session.resume"; token: string; sessionId: string; resumeToken: string; lastSeq: number }`.
  - `ServerControl` ganha `{ v: 1; type: "session.resumed"; sessionId: string; throughSeq: number }`, `{ v: 1; type: "session.superseded"; sessionId: string }` e `{ v: 1; type: "heartbeat"; sessionId: string }`.

- [ ] **Step 1: Write the failing test**

Em `packages/shared/src/messages.test.ts`, dentro de `describe("parseClientMessage", …)`, acrescente:

```ts
  it("aceita session.resume válido e recusa lastSeq negativo ou campos vazios", () => {
    const resume = { type: "session.resume", token: "k", sessionId: "s1", resumeToken: "r1", lastSeq: 12 };
    expect(parseClientMessage(JSON.stringify(resume))).toEqual(resume);
    expect(parseClientMessage(JSON.stringify({ ...resume, lastSeq: -1 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, lastSeq: 1.5 }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, sessionId: "" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...resume, resumeToken: "" }))).toBeNull();
  });
```

E, no `describe` de `parseServerMessage` (procure por `parseServerMessage(` no arquivo), acrescente:

```ts
  it("aceita as mensagens de controle da retomada, sem seq", () => {
    const resumed = { v: 1, type: "session.resumed", sessionId: "s1", throughSeq: 40 };
    const superseded = { v: 1, type: "session.superseded", sessionId: "s1" };
    const heartbeat = { v: 1, type: "heartbeat", sessionId: "s1" };
    for (const message of [resumed, superseded, heartbeat]) {
      const parsed = parseServerMessage(JSON.stringify(message));
      expect(parsed).toEqual(message);
      expect(parsed && isServerEvent(parsed)).toBe(false);
    }
    expect(parseServerMessage(JSON.stringify({ ...resumed, throughSeq: -1 }))).toBeNull();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/src/messages.test.ts`
Expected: FAIL (as duas novas `it` falham: `toBeNull`/`toEqual` recebem `null`).

- [ ] **Step 3: Write minimal implementation**

Em `packages/shared/src/messages.ts`, no `clientMessageSchema`, depois do objeto de `session.start`:

```ts
  z.object({
    type: z.literal("session.resume"),
    token: z.string().min(1),
    sessionId: z.string().min(1),
    resumeToken: z.string().min(1),
    /** Último evento que o cliente aplicou; o servidor repõe os seguintes. */
    lastSeq: z.number().int().min(0),
  }),
```

Depois de `sessionEndedSchema`:

```ts
const sessionResumedSchema = z.object({
  v: z.literal(1),
  type: z.literal("session.resumed"),
  sessionId: z.string().min(1),
  /** Último seq emitido no instante da retomada; os eventos repostos vêm logo depois. */
  throughSeq: z.number().int().min(0),
});

const sessionSupersededSchema = z.object({
  v: z.literal(1),
  type: z.literal("session.superseded"),
  sessionId: z.string().min(1),
});

// Sinal de vida: o cliente reconecta se ficar sem mensagens por muito tempo.
const heartbeatSchema = z.object({
  v: z.literal(1),
  type: z.literal("heartbeat"),
  sessionId: z.string().min(1),
});
```

No `serverMessageSchema`, logo depois de `sessionEndedSchema,`:

```ts
  sessionResumedSchema,
  sessionSupersededSchema,
  heartbeatSchema,
```

E troque o tipo `ServerControl` por:

```ts
export type ServerControl =
  | z.infer<typeof sessionStartedSchema>
  | z.infer<typeof sessionEndedSchema>
  | z.infer<typeof sessionResumedSchema>
  | z.infer<typeof sessionSupersededSchema>
  | z.infer<typeof heartbeatSchema>;
```

Em `apps/extension/src/offscreen/session-store.ts`, no `switch` de `applyServerMessage` para mensagens de controle, acrescente (o comportamento de `session.resumed` vem na Task 6):

```ts
      case "session.resumed":
      case "session.superseded":
      case "heartbeat":
        return state;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/shared && pnpm typecheck`
Expected: PASS, sem erros de tipo.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/extension/src/offscreen/session-store.ts
git commit -m "feat(shared): mensagens de retomada, sessão assumida e heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Buffer de eventos

**Files:**
- Create: `apps/server/src/event-buffer.ts`
- Test: `apps/server/src/event-buffer.test.ts`

**Interfaces:**
- Produces:
  - `export const DEFAULT_EVENT_BUFFER_SIZE = 2_000;`
  - `class EventBuffer { constructor(capacity?: number); add(event: ServerEvent): void; canReplayFrom(lastSeq: number): boolean; since(lastSeq: number): ServerEvent[] }`

- [ ] **Step 1: Write the failing test**

`apps/server/src/event-buffer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "@snowspeak/shared";
import { EventBuffer } from "./event-buffer";

const segment = (seq: number): ServerEvent => ({
  v: 1,
  sessionId: "s1",
  seq,
  ts: 0,
  type: "transcript.segment",
  channel: "them",
  utteranceId: "them-1",
  segmentIdx: seq,
  text: `t${seq}`,
});
const partial = (seq: number): ServerEvent => ({
  v: 1,
  sessionId: "s1",
  seq,
  ts: 0,
  type: "transcript.partial",
  channel: "them",
  utteranceId: "them-1",
  text: "…",
});

describe("EventBuffer", () => {
  it("devolve os eventos depois de lastSeq, em ordem, sem parciais", () => {
    const buffer = new EventBuffer();
    [segment(1), partial(2), segment(3), partial(4), segment(5)].forEach((e) => buffer.add(e));
    expect(buffer.since(1).map((e) => e.seq)).toEqual([3, 5]);
    expect(buffer.since(5)).toEqual([]);
  });

  it("guarda só os últimos eventos e sabe se ainda dá para repor", () => {
    const buffer = new EventBuffer(2);
    [segment(1), segment(2), segment(3)].forEach((e) => buffer.add(e));
    expect(buffer.since(0).map((e) => e.seq)).toEqual([2, 3]);
    expect(buffer.canReplayFrom(0)).toBe(false); // o 1 saiu do buffer
    expect(buffer.canReplayFrom(1)).toBe(true);
    expect(buffer.canReplayFrom(3)).toBe(true);
  });

  it("parciais não ocupam espaço nem tornam a reposição impossível", () => {
    const buffer = new EventBuffer(2);
    [segment(1), partial(2), partial(3), partial(4), segment(5)].forEach((e) => buffer.add(e));
    expect(buffer.canReplayFrom(0)).toBe(true);
    expect(buffer.since(0).map((e) => e.seq)).toEqual([1, 5]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/event-buffer.test.ts`
Expected: FAIL com "Failed to resolve import ./event-buffer".

- [ ] **Step 3: Write minimal implementation**

`apps/server/src/event-buffer.ts`:

```ts
import type { ServerEvent } from "@snowspeak/shared";

export const DEFAULT_EVENT_BUFFER_SIZE = 2_000;

// Últimos eventos da sessão, para repor o que o cliente perdeu numa queda.
// Parciais não entram: são provisórios e o texto firme chega depois como transcript.segment.
export class EventBuffer {
  private readonly events: ServerEvent[] = [];
  /** Maior seq que já saiu do buffer (0 = nenhum). */
  private evictedThrough = 0;

  constructor(private readonly capacity = DEFAULT_EVENT_BUFFER_SIZE) {}

  add(event: ServerEvent): void {
    if (event.type === "transcript.partial") return;
    this.events.push(event);
    if (this.events.length > this.capacity) this.evictedThrough = this.events.shift()?.seq ?? this.evictedThrough;
  }

  /** Tudo o que veio depois de lastSeq (fora parciais) ainda está no buffer. */
  canReplayFrom(lastSeq: number): boolean {
    return lastSeq >= this.evictedThrough;
  }

  since(lastSeq: number): ServerEvent[] {
    return this.events.filter((event) => event.seq > lastSeq);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/event-buffer.test.ts`
Expected: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/event-buffer.ts apps/server/src/event-buffer.test.ts
git commit -m "feat(server): buffer de eventos para repor o que o cliente perdeu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Canal que suspende e reabre o STT

**Files:**
- Modify: `apps/server/src/utterance-assembler.ts`
- Modify: `apps/server/src/channel-pipeline.ts`
- Test: `apps/server/src/utterance-assembler.test.ts`
- Create test: `apps/server/src/channel-pipeline.test.ts`

**Interfaces:**
- Consumes: `createScriptedSttHub()` de `apps/server/src/test-support/scripted-stt.ts` (`hub.factory`, `hub.channel(ch)` devolve o stream **mais recente** do canal, com `emit`, `writes`, `finalizes`, `closed`, `onFinalize`).
- Produces:
  - `UtteranceAssembler.resetTimeline(): void`
  - `ChannelPipeline.suspend(): Promise<void>` — entrega o que o STT tiver (`Finalize`, até 500 ms), fecha a fala aberta como interrompida e fecha o STT; montador, divisor de frases e sequenciador continuam.
  - `ChannelPipeline.reopenStt(): void` — abre um STT novo (se não houver um e o canal não estiver fechado), zera a linha do tempo.

- [ ] **Step 1: Write the failing tests**

Em `apps/server/src/utterance-assembler.test.ts`, acrescente dentro do `describe` principal:

```ts
  it("depois de resetTimeline, UtteranceEnd com tempos baixos fecha a fala nova", () => {
    const assembler = new UtteranceAssembler("them");
    assembler.push({ kind: "segment", text: "First.", start: 10, end: 12, speechFinal: true, fromFinalize: false });
    assembler.resetTimeline();
    assembler.push({ kind: "segment", text: "Second", start: 0.2, end: 0.8, speechFinal: false, fromFinalize: false });
    expect(assembler.push({ kind: "utteranceEnd", lastWordEnd: 0.8 })).toEqual([
      { type: "utterance.end", utteranceId: "them-2", interrupted: false },
    ]);
  });
```

(Se `UtteranceAssembler` não estiver importado no arquivo, ele já está: o arquivo testa essa classe.)

`apps/server/src/channel-pipeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerEventBody } from "@snowspeak/shared";
import { ChannelPipeline } from "./channel-pipeline";
import { LatencyStats } from "./latency";
import { createScriptedSttHub } from "./test-support/scripted-stt";

const frame = (frameSeq: number) => ({ channel: "them" as const, frameSeq, sampleOffset: frameSeq * 1600, pcm: new Uint8Array(3200) });

function setup() {
  const hub = createScriptedSttHub();
  const events: ServerEventBody[] = [];
  const pipeline = new ChannelPipeline({
    channel: "them",
    sttFactory: hub.factory,
    splitSentences: false,
    emit: (body) => events.push(body),
    sttLatency: new LatencyStats(),
    now: Date.now,
  });
  return { hub, events, pipeline };
}

describe("ChannelPipeline", () => {
  it("suspend pede Finalize, fecha a fala aberta como interrompida e fecha o STT", async () => {
    const { hub, events, pipeline } = setup();
    pipeline.acceptFrame(frame(0));
    const them = hub.channel("them");
    them.emit({ kind: "partial", text: "hel" });
    await pipeline.suspend();
    expect(them.finalizes).toBe(1);
    expect(them.closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "utterance.end", channel: "them", utteranceId: "them-1", interrupted: true });
  });

  it("reopenStt abre um STT novo e as falas continuam numeradas", async () => {
    const { hub, events, pipeline } = setup();
    hub.channel("them").emit({ kind: "segment", text: "Hi.", start: 5, end: 6, speechFinal: true, fromFinalize: false });
    await pipeline.suspend();
    const old = hub.channel("them");
    pipeline.reopenStt();
    const fresh = hub.channel("them");
    expect(fresh).not.toBe(old);
    expect(fresh.closed).toBe(false);
    pipeline.acceptFrame(frame(3));
    expect(fresh.writes).toBe(1);
    fresh.emit({ kind: "segment", text: "Again", start: 0.1, end: 0.5, speechFinal: false, fromFinalize: false });
    fresh.emit({ kind: "utteranceEnd", lastWordEnd: 0.5 });
    expect(events.slice(-2)).toEqual([
      { type: "transcript.segment", channel: "them", utteranceId: "them-2", segmentIdx: 0, text: "Again" },
      { type: "utterance.end", channel: "them", utteranceId: "them-2", interrupted: false },
    ]);
  });

  it("frames aceitos com o STT suspenso não vão a lugar nenhum, e reopenStt depois de close não abre nada", async () => {
    const { hub, pipeline } = setup();
    await pipeline.suspend();
    const suspended = hub.channel("them");
    expect(pipeline.acceptFrame(frame(0))).toBe(true);
    expect(suspended.writes).toBe(0);
    pipeline.close();
    pipeline.reopenStt();
    expect(hub.channel("them")).toBe(suspended);
  });
});
```

Confira em `apps/server/src/latency.ts` que `LatencyStats` tem construtor sem argumentos (é usado assim em `session.ts`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/server/src/utterance-assembler.test.ts apps/server/src/channel-pipeline.test.ts`
Expected: FAIL com "resetTimeline is not a function" e "suspend is not a function".

- [ ] **Step 3: Write minimal implementation**

Em `apps/server/src/utterance-assembler.ts`, depois de `forceClose()`:

```ts
  /** Stream novo do STT (retomada): os tempos dele recomeçam do zero. */
  resetTimeline(): void {
    this.lastClosedEnd = Number.NEGATIVE_INFINITY;
  }
```

Em `apps/server/src/channel-pipeline.ts`:

1. Troque `private readonly clock = new ForwardClock();` por `private clock = new ForwardClock();` e acrescente o campo `private closed = false;`.
2. No construtor, troque a criação do STT por `this.stt = this.openStt();` e acrescente o método:

```ts
  private openStt(): SttStream {
    return this.deps.sttFactory(this.deps.channel, {
      onResult: (result) => this.onSttResult(result),
      onError: (error) => this.onSttError(error),
    });
  }
```

3. Depois de `drain()`:

```ts
  /** Queda do socket: entrega o que o STT tiver, fecha a fala aberta e desliga o STT até a retomada. */
  async suspend(): Promise<void> {
    await this.drain();
    this.stt?.close();
    this.stt = null;
    this.audioForwarded = false;
  }

  /** Retomada: STT novo, cuja linha do tempo recomeça do zero. Falas e frases seguem a numeração. */
  reopenStt(): void {
    if (this.stt || this.closed) return;
    this.clock = new ForwardClock();
    this.assembler.resetTimeline();
    this.stt = this.openStt();
  }
```

4. Em `close()`, primeira linha: `this.closed = true;`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server`
Expected: PASS (inclusive os testes antigos de sessão).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/utterance-assembler.ts apps/server/src/utterance-assembler.test.ts apps/server/src/channel-pipeline.ts apps/server/src/channel-pipeline.test.ts
git commit -m "feat(server): canal que suspende e reabre o STT sem perder a numeração das falas

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Sessão com dono opcional, buffer e retomada

**Files:**
- Modify: `apps/server/src/session.ts`
- Modify: `apps/server/src/gateway.ts` (só a criação da sessão, para compilar)
- Create test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: `EventBuffer` (Task 2); `ChannelPipeline.suspend()`/`reopenStt()` (Task 3).
- Produces:
  - `export interface SessionOwner { send(message: ServerMessage): void; close(code: number, reason: string): void }`
  - `SessionDeps` sem `send`, com `eventBufferSize?: number`.
  - `new Session(deps: SessionDeps, settings: SuggestionSettings, accessKey: string)`
  - `readonly accessKey: string`, `get owner(): SessionOwner | null`, `get throughSeq(): number`
  - `attach(owner: SessionOwner): void` — dono de uma sessão nova (sem reposição)
  - `detach(): void` — desliga o dono e suspende os canais (assíncrono por dentro)
  - `replayCheck(lastSeq: number): "ok" | "ahead" | "gap"`
  - `resume(owner: SessionOwner, lastSeq: number): void` — envia `session.resumed`, repõe, troca o dono, reabre o STT depois da suspensão
  - `requestSuggestion`, `update`, `beginStop`, `drain`, `close`, `acceptFrame`: iguais a hoje. `close()` também zera o dono.

- [ ] **Step 1: Write the failing test**

`apps/server/src/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import { Session, type SessionOwner } from "./session";
import type { Suggester } from "./suggest/openrouter";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { waitUntil } from "./test-support/wait";

const idleSuggester: Suggester = {
  stream: () =>
    (async function* () {
      yield "<en>OK.</en><pt>Certo.</pt>";
    })(),
};

function owner(): SessionOwner & { messages: ServerMessage[]; closedWith: number | null } {
  const record = {
    messages: [] as ServerMessage[],
    closedWith: null as number | null,
    send: (message: ServerMessage) => record.messages.push(message),
    close: (code: number) => {
      record.closedWith = code;
    },
  };
  return record;
}

const segment = (text: string, speechFinal = false) =>
  ({ kind: "segment", text, start: 0, end: 1, speechFinal, fromFinalize: false }) as const;

function setup(eventBufferSize?: number) {
  const hub = createScriptedSttHub();
  const session = new Session(
    { sttFactory: hub.factory, suggester: idleSuggester, eventBufferSize },
    { mode: "work", context: "", profile: "", job: "" },
    "key-1",
  );
  return { hub, session };
}

describe("Session", () => {
  it("sem dono, os eventos vão só para o buffer; na retomada chegam depois de session.resumed", async () => {
    const { hub, session } = setup();
    const first = owner();
    session.attach(first);
    hub.channel("them").emit({ kind: "partial", text: "hel" });
    hub.channel("them").emit(segment("Hello."));
    const lastSeq = 2;
    session.detach();
    await waitUntil(() => hub.channel("them").closed && hub.channel("me").closed);
    // Fala aberta fechada como interrompida durante a queda (seq 3).
    const second = owner();
    expect(session.replayCheck(lastSeq)).toBe("ok");
    session.resume(second, lastSeq);
    expect(second.messages[0]).toEqual({ v: 1, type: "session.resumed", sessionId: session.id, throughSeq: 3 });
    expect(second.messages.slice(1)).toMatchObject([{ type: "utterance.end", seq: 3, interrupted: true }]);
    expect(first.messages.map((m) => m.type)).toEqual(["transcript.partial", "transcript.segment"]);
  });

  it("repõe sem parciais e reabre o STT depois da suspensão", async () => {
    const { hub, session } = setup();
    session.attach(owner());
    session.detach();
    await waitUntil(() => hub.channel("them").closed);
    const suspended = hub.channel("them");
    const next = owner();
    session.resume(next, 0);
    await waitUntil(() => hub.channel("them") !== suspended);
    hub.channel("them").emit({ kind: "partial", text: "again" });
    expect(next.messages.at(-1)).toMatchObject({ type: "transcript.partial", text: "again", utteranceId: "them-1" });
  });

  it("replayCheck: ahead quando lastSeq passou do último evento, gap quando o buffer já perdeu eventos", () => {
    const { hub, session } = setup(2);
    session.attach(owner());
    hub.channel("them").emit(segment("a"));
    hub.channel("them").emit(segment("b"));
    hub.channel("them").emit(segment("c"));
    expect(session.throughSeq).toBe(3);
    expect(session.replayCheck(4)).toBe("ahead");
    expect(session.replayCheck(0)).toBe("gap");
    expect(session.replayCheck(1)).toBe("ok");
  });

  it("close zera o dono e reopenStt não reabre nada depois", async () => {
    const { hub, session } = setup();
    session.attach(owner());
    session.close();
    expect(session.owner).toBeNull();
    session.resume(owner(), 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hub.channel("them").closed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/session.test.ts`
Expected: FAIL (erro de tipo/execução: `SessionOwner` não existe, `attach is not a function`).

- [ ] **Step 3: Write the implementation**

Em `apps/server/src/session.ts`:

1. Imports: acrescente `import { EventBuffer } from "./event-buffer";` e troque o import de tipos de `@snowspeak/shared` por `import type { AudioFrame, Channel, ServerEvent, ServerEventBody, ServerMessage } from "@snowspeak/shared";`.
2. Troque `SessionDeps` por:

```ts
export interface SessionDeps {
  sttFactory: SttFactory;
  suggester: Suggester;
  now?: () => number;
  /** Tamanho do buffer de reposição (padrão: DEFAULT_EVENT_BUFFER_SIZE). */
  eventBufferSize?: number;
}

/** O socket ligado à sessão (no máximo um por vez). */
export interface SessionOwner {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}
```

3. Campos e construtor:

```ts
export class Session {
  readonly id = randomUUID();
  readonly resumeToken = randomBytes(32).toString("base64url");
  private seq = 0;
  private closed = false;
  private currentOwner: SessionOwner | null = null;
  private readonly buffer: EventBuffer;
  // Suspensão dos canais depois de uma queda; a retomada só reabre o STT quando ela termina.
  private suspending: Promise<void> = Promise.resolve();
  private readonly sttLatency = new LatencyStats();
  private readonly pipelines: Record<Channel, ChannelPipeline>;
  private readonly engine: SuggestionEngine;
  private settings: SuggestionSettings;

  constructor(
    private readonly deps: SessionDeps,
    settings: SuggestionSettings,
    readonly accessKey: string,
  ) {
    this.buffer = new EventBuffer(deps.eventBufferSize);
    // … o resto do construtor atual, sem mudanças …
  }
```

4. Métodos novos (antes de `acceptFrame`):

```ts
  get owner(): SessionOwner | null {
    return this.currentOwner;
  }

  get throughSeq(): number {
    return this.seq;
  }

  /** Dono de uma sessão recém-criada. */
  attach(owner: SessionOwner): void {
    this.currentOwner = owner;
  }

  /** Queda do socket: a sessão continua; os canais entregam o que têm e desligam o STT. */
  detach(): void {
    if (!this.currentOwner) return;
    this.currentOwner = null;
    this.suspending = Promise.all([this.pipelines.them.suspend(), this.pipelines.me.suspend()]).then(() => undefined);
  }

  replayCheck(lastSeq: number): "ok" | "ahead" | "gap" {
    if (lastSeq > this.seq) return "ahead";
    return this.buffer.canReplayFrom(lastSeq) ? "ok" : "gap";
  }

  /** Retomada validada pelo gateway: repõe os eventos perdidos e passa a enviar para o novo dono. */
  resume(owner: SessionOwner, lastSeq: number): void {
    if (this.closed) return;
    owner.send({ v: 1, type: "session.resumed", sessionId: this.id, throughSeq: this.seq });
    for (const event of this.buffer.since(lastSeq)) owner.send(event);
    this.currentOwner = owner;
    void this.suspending.then(() => {
      if (this.closed || this.currentOwner !== owner) return;
      this.pipelines.them.reopenStt();
      this.pipelines.me.reopenStt();
    });
  }
```

5. Em `close()`, logo depois de `this.closed = true;`: `this.currentOwner = null;`.
6. Troque `emit` por:

```ts
  private emit(body: ServerEventBody): void {
    this.seq += 1;
    const event = { v: 1, sessionId: this.id, seq: this.seq, ts: (this.deps.now ?? Date.now)(), ...body } as ServerEvent;
    this.buffer.add(event);
    this.currentOwner?.send(event);
  }
```

Em `apps/server/src/gateway.ts`, para compilar (o gateway completo vem na Task 5), troque a criação da sessão por:

```ts
      session = new Session(
        { sttFactory: deps.sttFactory, suggester: deps.suggester },
        { mode: message.mode, context: message.context, profile: message.profile ?? "", job: message.job ?? "" },
        message.token,
      );
      session.attach({ send, close: (code, reason) => ws.close(code, reason) });
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run apps/server && pnpm typecheck`
Expected: PASS em todos os testes do servidor (os antigos de gateway e sessão continuam iguais).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts apps/server/src/gateway.ts
git commit -m "feat(server): sessão com dono opcional, buffer de eventos e retomada

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Registro de sessões e retomada pelo gateway

**Files:**
- Create: `apps/server/src/session-registry.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/config.test.ts`
- Modify: `apps/server/src/gateway.ts`
- Modify: `apps/server/src/test-support/test-client.ts`
- Modify: `apps/server/.env.example`
- Create test: `apps/server/src/session-resume.test.ts`

**Interfaces:**
- Consumes: `Session`, `SessionOwner` (Task 4); `DEFAULT_EVENT_BUFFER_SIZE` (Task 2).
- Produces:
  - `ServerConfig` ganha `resumeWindowMs: number; eventBufferSize: number; heartbeatIntervalMs: number; pingIntervalMs: number; devEndpoints: boolean`.
  - `class SessionRegistry { add(session); get(id); activeFor(accessKey); end(session); expireIn(session, ms); cancelExpiry(session); endAll(); readonly size }`.
  - `TestClient.lastSeq(): number` e `TestClient.started(url, token?)`.

- [ ] **Step 1: Config e cliente de teste**

`apps/server/src/config.ts`: acrescente ao `ServerConfig`:

```ts
  /** Quanto tempo uma sessão sem socket espera a retomada. */
  resumeWindowMs: number;
  eventBufferSize: number;
  heartbeatIntervalMs: number;
  pingIntervalMs: number;
  /** POST /dev/drop-sockets (só para validar a retomada). */
  devEndpoints: boolean;
```

E no objeto devolvido por `loadConfig` (importe `DEFAULT_EVENT_BUFFER_SIZE` de `./event-buffer`):

```ts
    resumeWindowMs: 60_000,
    eventBufferSize: DEFAULT_EVENT_BUFFER_SIZE,
    heartbeatIntervalMs: 5_000,
    pingIntervalMs: 10_000,
    devEndpoints: env.DEV_ENDPOINTS?.trim() === "1",
```

Em `apps/server/src/config.test.ts`, acrescente:

```ts
  it("aplica os prazos da retomada e liga os endpoints de desenvolvimento só com DEV_ENDPOINTS=1", () => {
    const config = loadConfig({ ACCESS_KEYS: "a", ALLOWED_ORIGINS: "o" });
    expect(config).toMatchObject({ resumeWindowMs: 60_000, eventBufferSize: 2_000, heartbeatIntervalMs: 5_000, pingIntervalMs: 10_000, devEndpoints: false });
    expect(loadConfig({ ACCESS_KEYS: "a", ALLOWED_ORIGINS: "o", DEV_ENDPOINTS: "1" }).devEndpoints).toBe(true);
  });
```

`apps/server/src/test-support/test-client.ts`:

- em `testConfig`, antes de `...overrides`:

```ts
    resumeWindowMs: 300,
    eventBufferSize: 2_000,
    // Longos por padrão: heartbeats e pings não aparecem nos testes que não tratam disso.
    heartbeatIntervalMs: 60_000,
    pingIntervalMs: 60_000,
    devEndpoints: false,
```

- troque `accessKeys: new Set(["key-1"])` por `accessKeys: new Set(["key-1", "key-2"])`;
- troque `static async started(url: string)` por:

```ts
  static async started(url: string, token = "key-1"): Promise<TestClient> {
    const client = await TestClient.connect(url);
    client.sendJson({ ...START, token });
    await client.waitFor((m) => m.type === "session.started");
    return client;
  }
```

- acrescente o método:

```ts
  /** Maior seq recebido (o que o cliente real mandaria em session.resume). */
  lastSeq(): number {
    return this.messages.reduce((max, m) => ("seq" in m ? Math.max(max, m.seq) : max), 0);
  }
```

`apps/server/.env.example`: acrescente no fim:

```
# 1 liga POST /dev/drop-sockets (derruba as conexões sem encerrar as sessões, para testar a retomada)
DEV_ENDPOINTS=
```

Run: `npx vitest run apps/server/src/config.test.ts`
Expected: FAIL até a config estar feita; depois PASS.

- [ ] **Step 2: Write the failing integration tests**

`apps/server/src/session-resume.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { startGateway, type Gateway } from "./gateway";
import type { Suggester } from "./suggest/openrouter";
import { createScriptedSttHub } from "./test-support/scripted-stt";
import { TestClient, testConfig } from "./test-support/test-client";
import { waitUntil } from "./test-support/wait";

const segment = (text: string, speechFinal = false) =>
  ({ kind: "segment", text, start: 0, end: 1, speechFinal, fromFinalize: false }) as const;

// Responde depois de um instante: dá tempo de derrubar o socket no meio.
const slowSuggester: Suggester = {
  stream: () =>
    (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield "<en>OK.</en><pt>Certo.</pt>";
    })(),
};

describe("retomada da sessão", () => {
  let gateway: Gateway;

  afterEach(async () => {
    await gateway.close();
  });

  async function setup(overrides: Partial<ServerConfig> = {}) {
    const hub = createScriptedSttHub();
    gateway = await startGateway(testConfig(overrides), { sttFactory: hub.factory, suggester: slowSuggester });
    return hub;
  }

  function startedOf(client: TestClient) {
    const started = client.messages.find((m) => m.type === "session.started");
    if (started?.type !== "session.started") throw new Error("sem session.started");
    return started;
  }

  async function resume(from: TestClient, lastSeq = from.lastSeq(), overrides: Record<string, unknown> = {}) {
    const started = startedOf(from);
    const client = await TestClient.connect(gateway.url);
    client.sendJson({ type: "session.resume", token: "key-1", sessionId: started.sessionId, resumeToken: started.resumeToken, lastSeq, ...overrides });
    return client;
  }

  it("repõe os eventos perdidos em ordem, sem parciais, depois de session.resumed", async () => {
    const hub = await setup();
    const a = await TestClient.started(gateway.url);
    hub.channel("them").emit({ kind: "partial", text: "hel" });
    hub.channel("them").emit(segment("Hello."));
    await a.waitFor((m) => m.type === "transcript.segment");
    a.drop();
    await waitUntil(() => hub.channel("them").closed);
    const b = await resume(a, 0);
    await b.waitFor((m) => m.type === "utterance.end");
    expect(b.types()).toEqual(["session.resumed", "transcript.segment", "utterance.end"]);
    expect(b.messages[0]).toMatchObject({ type: "session.resumed", throughSeq: 3 });
    expect(b.messages[2]).toMatchObject({ seq: 3, interrupted: true });
  });

  it("reabre o STT e mede a lacuna de áudio da queda", async () => {
    const hub = await setup();
    const a = await TestClient.started(gateway.url);
    a.sendSilence("them", 0);
    a.sendSilence("them", 1);
    await waitUntil(() => hub.channel("them").writes === 2);
    const before = hub.channel("them");
    a.drop();
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
    await waitUntil(() => hub.channel("them") !== before);
    b.sendSilence("them", 5);
    const gap = await b.waitFor((m) => m.type === "audio.gap");
    expect(gap).toMatchObject({ channel: "them", durationMs: 300, reason: "client_drop" });
    await waitUntil(() => hub.channel("them").writes === 1);
  });

  it("sugestão concluída durante a queda chega na reposição", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    a.sendJson({ type: "suggest.request", requestId: "r1" });
    await a.waitFor((m) => m.type === "suggestion.started");
    const lastSeq = a.lastSeq();
    a.drop();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const b = await resume(a, lastSeq);
    const done = await b.waitFor((m) => m.type === "suggestion.done");
    expect(done).toMatchObject({ requestId: "r1", en: "OK.", pt: "Certo." });
  });

  it("socket antigo ainda aberto recebe session.superseded e 4409; o novo assume", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
    await a.waitFor((m) => m.type === "session.superseded");
    expect((await a.closed).code).toBe(4409);
    // O fechamento do socket antigo não derruba a sessão: o novo segue recebendo.
    b.sendJson({ type: "suggest.request", requestId: "r2" });
    await b.waitFor((m) => m.type === "suggestion.started");
  });

  it("session.start com a mesma chave encerra a sessão anterior com replaced e 4410", async () => {
    await setup();
    const a = await TestClient.started(gateway.url);
    await TestClient.started(gateway.url);
    const ended = await a.waitFor((m) => m.type === "session.ended");
    expect(ended).toMatchObject({ reason: "replaced" });
    expect((await a.closed).code).toBe(4410);
  });

  it("chaves diferentes têm sessões independentes", async () => {
    await setup();
    const a = await TestClient.started(gateway.url, "key-1");
    await TestClient.started(gateway.url, "key-2");
    a.sendJson({ type: "suggest.request", requestId: "r3" });
    await a.waitFor((m) => m.type === "suggestion.started");
  });

  it.each([
    ["chave inválida", { token: "nope" }, 4401],
    ["resumeToken errado", { resumeToken: "wrong" }, 4404],
    ["sessão inexistente", { sessionId: "missing" }, 4404],
    ["sessão de outra chave", { token: "key-2" }, 4404],
    ["lastSeq à frente do servidor", { lastSeq: 99 }, 4400],
  ])("recusa a retomada: %s", async (_name, overrides, code) => {
    await setup();
    const a = await TestClient.started(gateway.url);
    a.drop();
    const b = await resume(a, 0, overrides);
    expect((await b.closed).code).toBe(code);
  });

  it("depois do prazo, a sessão expira: STT fechado e retomada com 4404", async () => {
    const hub = await setup({ resumeWindowMs: 50 });
    const a = await TestClient.started(gateway.url);
    a.drop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(hub.channel("them").closed).toBe(true);
    const b = await resume(a, 0);
    expect((await b.closed).code).toBe(4404);
  });

  it("eventos perdidos que já saíram do buffer: encerra a sessão e fecha com 4404", async () => {
    const hub = await setup({ eventBufferSize: 2 });
    const a = await TestClient.started(gateway.url);
    for (const text of ["a", "b", "c"]) hub.channel("them").emit(segment(text));
    await waitUntil(() => a.lastSeq() === 3);
    a.drop();
    const b = await resume(a, 0);
    expect((await b.closed).code).toBe(4404);
    const c = await resume(a, 3);
    expect((await c.closed).code).toBe(4404);
  });

  it("envia heartbeat periódico ao socket ligado", async () => {
    await setup({ heartbeatIntervalMs: 30 });
    const a = await TestClient.started(gateway.url);
    const beat = await a.waitFor((m) => m.type === "heartbeat");
    expect(beat).toMatchObject({ v: 1, sessionId: startedOf(a).sessionId });
    expect("seq" in (beat as ServerMessage)).toBe(false);
  });

  it("derruba o socket que não responde ao ping, e a sessão espera a retomada", async () => {
    await setup({ pingIntervalMs: 40 });
    const a = await TestClient.started(gateway.url);
    // Parado, o cliente não lê o ping nem responde com pong.
    a.ws.pause();
    expect((await a.closed).code).toBe(1006);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
  });

  it("POST /dev/drop-sockets derruba as conexões só com devEndpoints", async () => {
    await setup({ devEndpoints: true });
    const a = await TestClient.started(gateway.url);
    const http = gateway.url.replace("ws://", "http://").replace("/ws", "/dev/drop-sockets");
    expect((await fetch(http, { method: "POST" })).status).toBe(204);
    expect((await a.closed).code).toBe(1006);
    const b = await resume(a);
    await b.waitFor((m) => m.type === "session.resumed");
  });

  it("sem devEndpoints, /dev/drop-sockets responde 404", async () => {
    await setup();
    const http = gateway.url.replace("ws://", "http://").replace("/ws", "/dev/drop-sockets");
    expect((await fetch(http, { method: "POST" })).status).toBe(404);
  });
});
```

Nota para o teste de ping: `ws.pause()` existe no `ws` 8 (pausa a leitura do socket). Se `a.closed` não resolver com o cliente pausado, troque a pausa por `a.ws.pong = () => undefined;` **e** `(a.ws as unknown as { _receiver: { removeAllListeners(e: string): void } })._receiver.removeAllListeners("ping");` — e registre no commit qual das duas funcionou. Não enfraqueça a asserção.

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/server/src/session-resume.test.ts`
Expected: FAIL (o servidor fecha `session.resume` com 4401 "session.start required").

- [ ] **Step 4: Registro de sessões**

`apps/server/src/session-registry.ts`:

```ts
import type { Session } from "./session";

// Sessões vivas do servidor: por id (retomada) e por chave (uma sessão ativa por chave).
export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly byKey = new Map<string, string>();
  private readonly expiry = new Map<string, ReturnType<typeof setTimeout>>();

  get size(): number {
    return this.sessions.size;
  }

  add(session: Session): void {
    this.sessions.set(session.id, session);
    this.byKey.set(session.accessKey, session.id);
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  activeFor(accessKey: string): Session | undefined {
    const id = this.byKey.get(accessKey);
    return id ? this.sessions.get(id) : undefined;
  }

  /** Encerra a sessão (cancela sugestão, fecha STT) e a esquece. */
  end(session: Session): void {
    this.cancelExpiry(session);
    session.close();
    this.sessions.delete(session.id);
    if (this.byKey.get(session.accessKey) === session.id) this.byKey.delete(session.accessKey);
  }

  /** Sessão sem socket: encerra se ninguém retomar no prazo. */
  expireIn(session: Session, ms: number): void {
    this.cancelExpiry(session);
    this.expiry.set(
      session.id,
      setTimeout(() => this.end(session), ms),
    );
  }

  cancelExpiry(session: Session): void {
    const timer = this.expiry.get(session.id);
    if (timer) clearTimeout(timer);
    this.expiry.delete(session.id);
  }

  endAll(): void {
    for (const session of [...this.sessions.values()]) this.end(session);
  }
}
```

- [ ] **Step 5: Gateway**

Reescreva `apps/server/src/gateway.ts` assim (o que não aparece aqui, como `toBytes` e `GatewayDeps`, fica igual):

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { CLOSE_CODES, decodeFrame, parseClientMessage, type ClientMessage, type ServerMessage } from "@snowspeak/shared";
import type { ServerConfig } from "./config";
import { Session, type SessionOwner } from "./session";
import { SessionRegistry } from "./session-registry";
import type { SttFactory } from "./stt/types";
import type { Suggester } from "./suggest/openrouter";
import { TONE_PAGE_HTML } from "./tone-page";

// … GatewayDeps e Gateway iguais …

export async function startGateway(config: ServerConfig, deps: GatewayDeps): Promise<Gateway> {
  const registry = new SessionRegistry();
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (req.url === "/tone") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(TONE_PAGE_HTML);
      return;
    }
    // Só para validar a retomada: derruba as conexões sem encerrar as sessões.
    if (config.devEndpoints && req.method === "POST" && req.url === "/dev/drop-sockets") {
      for (const client of wss.clients) client.terminate();
      res.writeHead(204).end();
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
  wss.on("connection", (ws) => handleConnection(ws, config, deps, registry));
  wss.on("error", (error) => console.warn(`erro no servidor WebSocket: ${error.message}`));

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const client of wss.clients) client.terminate();
      registry.endAll();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function handleConnection(ws: WebSocket, config: ServerConfig, deps: GatewayDeps, registry: SessionRegistry): void {
  let session: Session | null = null;
  let stopping = false;
  let rejectedFrames = 0;
  let answeredPing = true;

  const send = (message: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const owner: SessionOwner = { send, close: (code, reason) => ws.close(code, reason) };
  // Depois de uma retomada por outro socket, este deixa de mandar na sessão.
  const ownsSession = (): boolean => session !== null && session.owner === owner;

  const authTimer = setTimeout(() => ws.close(CLOSE_CODES.unauthorized, "auth timeout"), config.authTimeoutMs);
  const heartbeat = setInterval(() => {
    if (session && ownsSession()) send({ v: 1, type: "heartbeat", sessionId: session.id });
  }, config.heartbeatIntervalMs);
  ws.on("pong", () => {
    answeredPing = true;
  });
  const ping = setInterval(() => {
    if (!answeredPing) {
      ws.terminate();
      return;
    }
    answeredPing = false;
    ws.ping();
  }, config.pingIntervalMs);

  const startSession = (message: Extract<ClientMessage, { type: "session.start" }>): Session | null => {
    if (!config.accessKeys.has(message.token)) {
      ws.close(CLOSE_CODES.unauthorized, "invalid token");
      return null;
    }
    clearTimeout(authTimer);
    // Uma sessão ativa por chave: a anterior é encerrada.
    const previous = registry.activeFor(message.token);
    if (previous) {
      const previousOwner = previous.owner;
      registry.end(previous);
      previousOwner?.send({ v: 1, type: "session.ended", sessionId: previous.id, reason: "replaced" });
      previousOwner?.close(CLOSE_CODES.sessionEnded, "replaced");
    }
    const created = new Session(
      { sttFactory: deps.sttFactory, suggester: deps.suggester, eventBufferSize: config.eventBufferSize },
      { mode: message.mode, context: message.context, profile: message.profile ?? "", job: message.job ?? "" },
      message.token,
    );
    registry.add(created);
    created.attach(owner);
    send({ v: 1, type: "session.started", sessionId: created.id, resumeToken: created.resumeToken });
    return created;
  };

  const resumeSession = (message: Extract<ClientMessage, { type: "session.resume" }>): Session | null => {
    if (!config.accessKeys.has(message.token)) {
      ws.close(CLOSE_CODES.unauthorized, "invalid token");
      return null;
    }
    clearTimeout(authTimer);
    const target = registry.get(message.sessionId);
    if (!target || target.resumeToken !== message.resumeToken || target.accessKey !== message.token) {
      ws.close(CLOSE_CODES.sessionNotFound, "session not found");
      return null;
    }
    const check = target.replayCheck(message.lastSeq);
    if (check === "ahead") {
      ws.close(CLOSE_CODES.protocolError, "lastSeq ahead");
      return null;
    }
    if (check === "gap") {
      // Eventos perdidos já saíram do buffer: não há como repor.
      registry.end(target);
      ws.close(CLOSE_CODES.sessionNotFound, "events lost");
      return null;
    }
    const previousOwner = target.owner;
    if (previousOwner) {
      previousOwner.send({ v: 1, type: "session.superseded", sessionId: target.id });
      previousOwner.close(CLOSE_CODES.superseded, "superseded");
    }
    registry.cancelExpiry(target);
    target.resume(owner, message.lastSeq);
    return target;
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      if (!session) {
        ws.close(CLOSE_CODES.protocolError, "audio before session");
        return;
      }
      if (stopping || !ownsSession()) return;
      const decoded = decodeFrame(toBytes(data));
      if (!decoded.ok || !session.acceptFrame(decoded.frame)) rejectedFrames += 1;
      return;
    }

    const message = parseClientMessage(data.toString());
    if (!session) {
      if (message?.type === "session.start") session = startSession(message);
      else if (message?.type === "session.resume") session = resumeSession(message);
      else ws.close(CLOSE_CODES.unauthorized, "session.start required");
      return;
    }

    if (stopping || !ownsSession()) return;

    if (message?.type === "session.stop") {
      stopping = true;
      const current = session;
      current.beginStop();
      // Entrega as últimas palavras e frases antes de encerrar.
      void current.drain().finally(() => {
        // end() cancela a sugestão em andamento e avisa antes do session.ended.
        registry.end(current);
        send({ v: 1, type: "session.ended", sessionId: current.id, reason: "stopped" });
        ws.close(CLOSE_CODES.sessionEnded, "stopped");
      });
      return;
    }

    if (message?.type === "session.update") {
      session.update(message);
      return;
    }

    if (message?.type === "suggest.request") {
      session.requestSuggestion(message.requestId, message.question);
      return;
    }

    ws.close(CLOSE_CODES.protocolError, "invalid message");
  });

  // Sem este listener, um erro de protocolo (ex.: mensagem acima de maxPayload) derrubaria o processo.
  // O ws já fecha a conexão com o código adequado; só registramos.
  ws.on("error", (error) => console.warn(`conexão encerrada por erro de protocolo: ${error.message}`));

  ws.on("close", () => {
    clearTimeout(authTimer);
    clearInterval(heartbeat);
    clearInterval(ping);
    // Queda: a sessão espera a retomada. Socket já substituído ou sessão parando: nada a fazer.
    if (session && ownsSession() && !stopping) {
      session.detach();
      registry.expireIn(session, config.resumeWindowMs);
    }
    if (rejectedFrames > 0) console.warn(`conexão encerrada com ${rejectedFrames} frames rejeitados`);
  });
}
```

Atenção: `session.stop` usa `registry.end(current)` no lugar de `current.close()`; `end` chama `close()` e tira a sessão do registro.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run apps/server && pnpm typecheck`
Expected: PASS em tudo. O teste antigo "fecha as conexões de STT quando o socket cai" continua passando (a suspensão fecha o STT).

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(server): retomada da sessão, uma sessão por chave, heartbeat e ping

Sessões sem socket esperam 60 s pela retomada; session.resume repõe os
eventos perdidos, assume a sessão (4409 para o socket antigo) e reabre o
STT. POST /dev/drop-sockets (DEV_ENDPOINTS=1) derruba as conexões para
validar a retomada.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Estado "reconectando" no store e no painel

**Files:**
- Modify: `apps/extension/src/offscreen/session-store.ts`, `session-store.test.ts`
- Modify: `apps/extension/src/sidepanel/panel-view.ts`, `panel-view.test.ts`
- Modify: `apps/extension/src/sidepanel/main.ts`

**Interfaces:**
- Produces:
  - `SessionStatus` = `"idle" | "starting" | "running" | "reconnecting" | "stopping" | "error"`.
  - `SessionState.resumeToken: string | null`.
  - `StoreAction` ganha `{ type: "reconnecting" }`.
  - `session.resumed` → `status: "running"`, nada mais muda.

- [ ] **Step 1: Write the failing tests**

Em `apps/extension/src/offscreen/session-store.test.ts`, no `describe("reduce", …)`:

```ts
  it("guarda o resumeToken, vai para reconectando sem perder a legenda e volta com session.resumed", () => {
    const withCaption = run(
      { type: "starting" },
      { type: "server", message: started },
      { type: "server", message: partial(1, "hi") },
      { type: "level", channel: "them", rms: 0.5 },
    );
    expect(withCaption.resumeToken).toBe("r1");
    const reconnecting = reduce(withCaption, { type: "reconnecting" });
    expect(reconnecting).toMatchObject({ status: "reconnecting", lastSeq: 1, sessionId: "s1", resumeToken: "r1" });
    expect(reconnecting.captions).toHaveLength(1);
    expect(reconnecting.channels.them.level).toBe(0);
    const resumed = reduce(reconnecting, { type: "server", message: { v: 1, type: "session.resumed", sessionId: "s1", throughSeq: 4 } });
    expect(resumed).toMatchObject({ status: "running", lastSeq: 1, resumeToken: "r1" });
    expect(resumed.captions).toBe(reconnecting.captions);
  });

  it("heartbeat e session.superseded não mudam o estado", () => {
    const state = run({ type: "server", message: started });
    expect(reduce(state, { type: "server", message: { v: 1, type: "heartbeat", sessionId: "s1" } })).toBe(state);
    expect(reduce(state, { type: "server", message: { v: 1, type: "session.superseded", sessionId: "s1" } })).toBe(state);
  });
```

Em `apps/extension/src/sidepanel/panel-view.test.ts`, no `describe("isCaptureMode", …)`, dentro do primeiro `it`, acrescente:

```ts
    expect(isCaptureMode("reconnecting", false)).toBe(true);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/extension/src/offscreen/session-store.test.ts apps/extension/src/sidepanel/panel-view.test.ts`
Expected: FAIL (`resumeToken` indefinido; `reconnecting` fora do modo captura).

- [ ] **Step 3: Implementation**

`apps/extension/src/offscreen/session-store.ts`:

- `export type SessionStatus = "idle" | "starting" | "running" | "reconnecting" | "stopping" | "error";`
- em `SessionState`, depois de `sessionId`: `resumeToken: string | null;`
- em `initialState()`: `resumeToken: null,`
- em `StoreAction`, antes de `{ type: "stopping" }`: `  /** Conexão caiu; a captura continua enquanto o controlador tenta retomar. */\n  | { type: "reconnecting" }`
- no `switch` de controle de `applyServerMessage`:

```ts
      case "session.started":
        return { ...state, status: "running", sessionId: message.sessionId, resumeToken: message.resumeToken, lastSeq: 0 };
      case "session.resumed":
        return { ...state, status: "running" };
      case "session.superseded":
      case "heartbeat":
        return state;
```

  (remova o `case "session.resumed":` que a Task 1 tinha posto junto com os outros dois).
- em `reduce`, antes de `case "stopping":`:

```ts
    case "reconnecting":
      return { ...state, status: "reconnecting", channels: silenced(state) };
```

`apps/extension/src/sidepanel/panel-view.ts`, em `isCaptureMode`:

```ts
  return pendingStart || status === "starting" || status === "running" || status === "reconnecting" || status === "stopping";
```

`apps/extension/src/sidepanel/main.ts`:

- em `STATUS_LABELS`, depois de `running`: `  reconnecting: "Reconectando…",`
- em `render()`, troque a linha do `active` por:

```ts
  const active = pendingStart || state.status === "starting" || state.status === "running" || state.status === "reconnecting";
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run apps/extension && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src
git commit -m "feat(extension): estado reconectando e resumeToken no store e no painel

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Reconexão no controlador

**Files:**
- Modify: `apps/extension/src/offscreen/session-controller.ts`
- Test: `apps/extension/src/offscreen/session-controller.test.ts`

**Interfaces:**
- Consumes: `{ type: "reconnecting" }` e `SessionState.lastSeq` do store (Task 6); mensagens `session.resume`/`session.resumed` (Task 1).
- Produces (exportados):
  - `RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000]`
  - `RESUME_WINDOW_MS = 60_000`
  - `SERVER_SILENCE_TIMEOUT_MS = 15_000`
  - `SESSION_EXPIRED_MESSAGE`, `SESSION_SUPERSEDED_MESSAGE`, `SESSION_REPLACED_MESSAGE` (textos em Global Constraints)

O arquivo de teste já usa `vi.useFakeTimers()` em `beforeEach` e tem os auxiliares `setup()`, `startRunning(t)`, `params`, `started` e `FakeSocket` (`open()`, `receive()`, `serverClose(code)`, `json`, `binary`, `closed`).

- [ ] **Step 1: Write the failing tests**

No topo de `session-controller.test.ts`, acrescente ao import de `./session-controller`: `RECONNECT_DELAYS_MS, RESUME_WINDOW_MS, SERVER_SILENCE_TIMEOUT_MS, SESSION_EXPIRED_MESSAGE, SESSION_REPLACED_MESSAGE, SESSION_SUPERSEDED_MESSAGE`. Depois, no fim do arquivo:

```ts
describe("reconexão", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const resumed: ServerMessage = { v: 1, type: "session.resumed", sessionId: "s1", throughSeq: 0 };
  const segment = (seq: number): ServerMessage => ({
    v: 1,
    type: "transcript.segment",
    sessionId: "s1",
    seq,
    ts: 0,
    channel: "them",
    utteranceId: "them-1",
    segmentIdx: 0,
    text: "Hello.",
  });

  it("queda sem código de aplicação: captura continua e retoma com o lastSeq do store", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.receive(segment(7));
    first.serverClose(1006);
    expect(t.store.snapshot().status).toBe("reconnecting");
    expect(t.tab.stopped).toBe(false);
    expect(t.mic.stopped).toBe(false);
    t.emitFrame("them"); // descartado: sem conexão
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    const second = t.sockets[1]!;
    second.open();
    expect(second.json).toEqual([{ type: "session.resume", token: "key-1", sessionId: "s1", resumeToken: "r1", lastSeq: 7 }]);
    second.receive({ ...resumed, throughSeq: 7 });
    expect(t.store.snapshot()).toMatchObject({ status: "running", lastSeq: 7 });
    t.emitFrame("them");
    expect(second.binary).toHaveLength(1);
    expect(first.binary).toHaveLength(0);
  });

  it("tenta de novo com espera crescente e desiste 60 s depois da queda", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.serverClose(1006);
    const opened: number[] = [];
    let elapsed = 0;
    while (t.store.snapshot().status === "reconnecting" && elapsed <= RESUME_WINDOW_MS + 10_000) {
      vi.advanceTimersByTime(100);
      elapsed += 100;
      const last = t.sockets.at(-1)!;
      if (t.sockets.length - 1 > opened.length) {
        opened.push(elapsed);
        last.serverClose(1006); // tentativa falha sem abrir
      }
    }
    expect(opened.slice(0, 7)).toEqual([500, 1_500, 3_500, 7_500, 15_500, 25_500, 35_500]);
    expect(opened.at(-1)).toBeLessThanOrEqual(RESUME_WINDOW_MS);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: SESSION_EXPIRED_MESSAGE });
    expect(t.tab.stopped).toBe(true);
  });

  it("15 s sem mensagens do servidor derruba a conexão e reconecta", async () => {
    const t = setup();
    const first = await startRunning(t);
    vi.advanceTimersByTime(SERVER_SILENCE_TIMEOUT_MS - 1_000);
    first.receive({ v: 1, type: "heartbeat", sessionId: "s1" });
    vi.advanceTimersByTime(SERVER_SILENCE_TIMEOUT_MS - 1_000);
    expect(t.store.snapshot().status).toBe("running");
    vi.advanceTimersByTime(1_000);
    expect(first.closed).toBe(true);
    expect(t.store.snapshot().status).toBe("reconnecting");
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    expect(t.sockets).toHaveLength(2);
  });

  it("tentativa que não responde em 5 s conta como falha e agenda a próxima", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.serverClose(1006);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    t.sockets[1]!.open(); // abre, mas o servidor nunca responde
    vi.advanceTimersByTime(5_000);
    expect(t.sockets[1]!.closed).toBe(true);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[1]!);
    expect(t.sockets).toHaveLength(3);
  });

  it("Parar durante a reconexão cancela as tentativas e libera a captura", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.serverClose(1006);
    t.controller.stop();
    expect(t.store.snapshot()).toMatchObject({ status: "idle" });
    expect(t.tab.stopped).toBe(true);
    vi.advanceTimersByTime(RESUME_WINDOW_MS);
    expect(t.sockets).toHaveLength(1);
  });

  it("não envia sugestão nem mudanças antes do session.resumed", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.serverClose(1006);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    const second = t.sockets[1]!;
    second.open();
    t.controller.requestSuggestion();
    t.controller.update({ job: "x" });
    expect(second.json.map((m) => m.type)).toEqual(["session.resume"]);
  });

  it.each([
    [4404, SESSION_EXPIRED_MESSAGE],
    [4400, SESSION_EXPIRED_MESSAGE],
    [4409, SESSION_SUPERSEDED_MESSAGE],
    [4401, "Chave de acesso inválida."],
  ])("retomada recusada com %i: para e mostra a mensagem", async (code, message) => {
    const t = setup();
    const first = await startRunning(t);
    first.serverClose(1006);
    vi.advanceTimersByTime(RECONNECT_DELAYS_MS[0]!);
    t.sockets[1]!.open();
    t.sockets[1]!.serverClose(code);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: message });
    expect(t.tab.stopped).toBe(true);
    vi.advanceTimersByTime(RESUME_WINDOW_MS);
    expect(t.sockets).toHaveLength(2);
  });

  it("4409 com a sessão ativa também para, sem reconectar", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.receive({ v: 1, type: "session.superseded", sessionId: "s1" });
    first.serverClose(4409);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: SESSION_SUPERSEDED_MESSAGE });
    vi.advanceTimersByTime(RESUME_WINDOW_MS);
    expect(t.sockets).toHaveLength(1);
  });

  it("sessão substituída por outro Iniciar: mostra a mensagem própria", async () => {
    const t = setup();
    const first = await startRunning(t);
    first.receive({ v: 1, type: "session.ended", sessionId: "s1", reason: "replaced" });
    first.serverClose(4410);
    expect(t.store.snapshot()).toMatchObject({ status: "error", errorMessage: SESSION_REPLACED_MESSAGE });
  });

  it("queda antes do session.started não reconecta", async () => {
    const t = setup();
    await t.controller.start(params);
    t.sockets[0]!.open();
    t.sockets[0]!.serverClose(1006);
    expect(t.store.snapshot().status).toBe("error");
    vi.advanceTimersByTime(RESUME_WINDOW_MS);
    expect(t.sockets).toHaveLength(1);
  });
});
```

Os tempos de abertura em "espera crescente" são cumulativos a partir da queda: 500; 500+1.000; +2.000; +4.000; +8.000; +10.000; +10.000 = 500, 1.500, 3.500, 7.500, 15.500, 25.500, 35.500 (e ainda 45.500 e 55.500; a próxima, 65.500, passaria de 60 s e não acontece).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/extension/src/offscreen/session-controller.test.ts`
Expected: FAIL (constantes inexistentes; queda vira erro em vez de reconectar).

- [ ] **Step 3: Implementation**

Em `apps/extension/src/offscreen/session-controller.ts`:

1. Import: `import { CLOSE_CODES, type Channel, type ClientMessage, type Mode, type ServerMessage, type SessionEndReason } from "@snowspeak/shared";`
2. Constantes, depois de `STOP_TIMEOUT_MS`:

```ts
// Reconexão depois de uma queda: espera crescente, até 60 s contados da queda.
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];
export const RESUME_WINDOW_MS = 60_000;
// O servidor manda heartbeat a cada 5 s; sem nenhuma mensagem por 15 s, a conexão está morta.
export const SERVER_SILENCE_TIMEOUT_MS = 15_000;

export const SESSION_EXPIRED_MESSAGE = "A conexão ficou fora por muito tempo e a sessão foi encerrada.";
export const SESSION_SUPERSEDED_MESSAGE = "Sessão aberta em outro lugar.";
export const SESSION_REPLACED_MESSAGE = "Sessão encerrada: foi iniciada em outro lugar.";
```

3. Troque a interface `Run` por:

```ts
interface Reconnect {
  since: number;
  attempt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Run {
  params: StartParams;
  tab: ChannelCapture | null;
  mic: ChannelCapture | null;
  socket: ControllerSocket | null;
  sender: FrameSender | null;
  wasOpen: boolean;
  /** Sessão iniciada ou retomada neste socket: frames e pedidos podem ir ao servidor. */
  live: boolean;
  sessionId: string | null;
  resumeToken: string | null;
  endedReason: SessionEndReason | null;
  reconnect: Reconnect | null;
  statsTimer: ReturnType<typeof setInterval> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
}
```

4. Acrescente, depois de `describeClose`:

```ts
function isApplicationClose(code: number): boolean {
  return code >= 4400 && code <= 4499;
}
```

5. Em `start()`, o objeto `run` passa a ser:

```ts
    const run: Run = {
      params,
      tab: null,
      mic: null,
      socket: null,
      sender: null,
      wasOpen: false,
      live: false,
      sessionId: null,
      resumeToken: null,
      endedReason: null,
      reconnect: null,
      statsTimer: null,
      startTimer: null,
      silenceTimer: null,
      stopping: false,
      stopTimer: null,
    };
```

   e todo o trecho de `let socket: ControllerSocket;` até `run.startTimer = setTimeout(…);` (inclusive) é trocado por:

```ts
    const startMessage: ClientMessage = {
      type: "session.start",
      token: params.token,
      mode: params.mode,
      context: params.context,
      profile: params.profile,
      job: params.job,
    };
    if (!this.connect(run, () => startMessage)) {
      this.fail(run, "Endereço do servidor inválido.");
      return;
    }
```

   (o `run.statsTimer = setInterval(…)` logo depois continua igual).

6. `requestSuggestion` e `update`: troque a guarda por `if (!run?.live || run.stopping || !run.socket?.isOpen) return;` e, em `requestSuggestion`, mantenha o resto igual.

7. `stop()`: troque o início por:

```ts
  stop(): void {
    const run = this.running;
    if (!run || run.stopping) return;
    if (!run.live || !run.socket?.isOpen) {
      // Sessão ainda não começou ou está reconectando: não há o que finalizar agora.
      if (!run.reconnect) run.socket?.sendJson({ type: "session.stop" });
      this.release(run);
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
```

   (o resto do método fica igual).

8. Métodos novos e substituídos (troque `onServerMessage` e `onSocketClose` inteiros):

```ts
  /** Abre um socket para esta execução; `first` é a primeira mensagem (início ou retomada). */
  private connect(run: Run, first: () => ClientMessage): boolean {
    let socket: ControllerSocket;
    try {
      socket = this.deps.openSocket(run.params.serverUrl, {
        onOpen: () => {
          if (run.socket !== socket) return;
          run.wasOpen = true;
          socket.sendJson(first());
        },
        onMessage: (message) => {
          if (run.socket === socket) this.onServerMessage(run, message);
        },
        onClose: (code) => {
          if (run.socket === socket) this.onSocketClose(run, code);
        },
      });
    } catch {
      return false;
    }
    run.socket = socket;
    run.startTimer = setTimeout(() => {
      if (this.running !== run || run.socket !== socket) return;
      if (run.reconnect) this.onConnectionLost(run);
      else this.fail(run, "O servidor não respondeu a tempo.");
    }, SESSION_START_TIMEOUT_MS);
    return true;
  }

  private onServerMessage(run: Run, message: ServerMessage): void {
    if (this.running !== run) return;
    if (message.type === "session.started" || message.type === "session.resumed") {
      if (run.startTimer) clearTimeout(run.startTimer);
      run.startTimer = null;
      if (message.type === "session.started") {
        run.sessionId = message.sessionId;
        run.resumeToken = message.resumeToken;
      }
      if (run.reconnect?.timer) clearTimeout(run.reconnect.timer);
      run.reconnect = null;
      run.live = true;
      // Frames só com a sessão viva; os contadores sobrevivem às reconexões.
      run.sender ??= new FrameSender({
        get bufferedAmount() {
          return run.socket?.bufferedAmount ?? 0;
        },
        get isOpen() {
          return run.live && (run.socket?.isOpen ?? false);
        },
        send: (data) => run.socket?.send(data),
      });
    }
    if (message.type === "session.ended") run.endedReason = message.reason;
    if (run.live) this.watchSilence(run);
    this.deps.store.dispatch({ type: "server", message });
    this.deps.onServerMessage?.(message);
  }

  private watchSilence(run: Run): void {
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = setTimeout(() => {
      if (this.running === run && run.live && !run.stopping) this.onConnectionLost(run);
    }, SERVER_SILENCE_TIMEOUT_MS);
  }

  private onSocketClose(run: Run, code: number): void {
    if (this.running !== run) return;
    if (run.stopping || (code === CLOSE_CODES.sessionEnded && run.endedReason !== "replaced")) {
      this.release(run);
      this.deps.store.dispatch({ type: "stopped" });
      return;
    }
    if (code === CLOSE_CODES.sessionEnded) return this.fail(run, SESSION_REPLACED_MESSAGE);
    if (code === CLOSE_CODES.superseded) return this.fail(run, SESSION_SUPERSEDED_MESSAGE);
    if (run.sessionId && (code === CLOSE_CODES.sessionNotFound || code === CLOSE_CODES.protocolError)) {
      return this.fail(run, SESSION_EXPIRED_MESSAGE);
    }
    // Sem sessão iniciada (ainda não há o que retomar) ou recusa do servidor: encerra como hoje.
    if (!run.sessionId || isApplicationClose(code)) return this.fail(run, describeClose(code, run.wasOpen));
    this.onConnectionLost(run);
  }

  /** Queda (ou conexão morta): a captura continua e o controlador tenta retomar a sessão. */
  private onConnectionLost(run: Run): void {
    run.live = false;
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = null;
    if (run.startTimer) clearTimeout(run.startTimer);
    run.startTimer = null;
    const socket = run.socket;
    run.socket = null;
    socket?.close();
    if (!run.reconnect) {
      run.reconnect = { since: Date.now(), attempt: 0, timer: null };
      this.deps.store.dispatch({ type: "reconnecting" });
    }
    this.scheduleReconnect(run, run.reconnect);
  }

  private scheduleReconnect(run: Run, reconnect: Reconnect): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnect.attempt, RECONNECT_DELAYS_MS.length - 1)] ?? RECONNECT_DELAYS_MS[0]!;
    if (Date.now() + delay - reconnect.since > RESUME_WINDOW_MS) {
      this.fail(run, SESSION_EXPIRED_MESSAGE);
      return;
    }
    reconnect.attempt += 1;
    reconnect.timer = setTimeout(() => {
      reconnect.timer = null;
      if (this.running !== run || run.reconnect !== reconnect || !run.sessionId || !run.resumeToken) return;
      const { sessionId, resumeToken } = run;
      const connected = this.connect(run, () => ({
        type: "session.resume",
        token: run.params.token,
        sessionId,
        resumeToken,
        // Lido na hora do envio: eventos aplicados até ali não são pedidos de novo.
        lastSeq: this.deps.store.snapshot().lastSeq,
      }));
      if (!connected) this.fail(run, "Endereço do servidor inválido.");
    }, delay);
  }
```

9. `release()`: acrescente, antes de `this.releaseCaptures(run);`:

```ts
    if (run.silenceTimer) clearTimeout(run.silenceTimer);
    run.silenceTimer = null;
    if (run.reconnect?.timer) clearTimeout(run.reconnect.timer);
    run.reconnect = null;
    run.live = false;
```

Note que `run.sender` passa a ser criado no primeiro `session.started` (com um "sink" que sempre usa o socket atual), e não mais com o socket fixo.

- [ ] **Step 4: Run tests**

Run: `npx vitest run apps/extension && pnpm typecheck`
Expected: PASS, incluindo os testes antigos (a queda antes de `session.started` continua mostrando "Não foi possível conectar ao servidor." ou o código).

Se o teste antigo que fazia `serverClose(1006)` **depois** de `session.started` e esperava erro existir, ele agora contradiz a spec: troque a expectativa para `status: "reconnecting"`, e registre isso no commit.

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/offscreen
git commit -m "feat(extension): reconexão automática com retomada da sessão

Queda sem código de aplicação mantém a captura e tenta session.resume com
espera de 0,5 a 10 s por até 60 s. 15 s sem mensagens do servidor contam
como queda. 4404/4400, 4409 e sessão substituída param com mensagem própria.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Roteiro de validação e verificação final

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Roteiro no README**

Depois da seção "Marco 5 — roteiro de validação", acrescente:

```markdown
## Marco 2 — roteiro de validação (reconexão)

Ponha `DEV_ENDPOINTS=1` no `apps/server/.env` e reinicie o servidor.

- [ ] No meio da sessão, `curl -X POST localhost:8787/dev/drop-sockets`: o painel mostra "Reconectando…" por um instante e volta para "Capturando"; a legenda anterior continua e as falas seguem aparecendo.
- [ ] A fala que estava em andamento na queda aparece como "fala interrompida"; a seguinte ganha um bloco novo, sem repetir texto.
- [ ] Uma sugestão pedida logo antes da queda aparece depois da volta.
- [ ] Parar o servidor e esperar mais de 60 s: aparece "A conexão ficou fora por muito tempo e a sessão foi encerrada.", a captura é liberada e a legenda continua visível.
- [ ] Reiniciar o servidor no meio da sessão: aparece a mesma mensagem (as sessões vivem na memória do servidor).
- [ ] Clicar em Parar durante "Reconectando…": Parado, sem captura.
- [ ] Iniciar uma sessão em outro perfil do Chrome com a mesma chave: a primeira mostra "Sessão encerrada: foi iniciada em outro lugar."
- [ ] Com o servidor em outra máquina, desligar o Wi-Fi por ~10 s e religar: a sessão volta sozinha.
```

- [ ] **Step 2: Verificação completa**

Run: `pnpm test && pnpm typecheck && pnpm --filter @snowspeak/extension build`
Expected: todos os testes passam, sem erros de tipo, build `✓ built`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: roteiro de validação do marco 2

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
