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
    const lastSeq = 2; // o cliente não chegou a aplicar o sentence.ready
    session.detach();
    await waitUntil(() => hub.channel("them").closed && hub.channel("me").closed);
    // "Hello." termina frase (sentence.ready, seq 3); a fala aberta fecha como interrompida na queda (seq 4).
    const second = owner();
    expect(session.replayCheck(lastSeq)).toBe("ok");
    session.resume(second, lastSeq);
    expect(second.messages[0]).toEqual({ v: 1, type: "session.resumed", sessionId: session.id, throughSeq: 4 });
    expect(second.messages.slice(1)).toMatchObject([
      { type: "sentence.ready", seq: 3 },
      { type: "utterance.end", seq: 4, interrupted: true },
    ]);
    expect(first.messages.map((m) => m.type)).toEqual(["transcript.partial", "transcript.segment", "sentence.ready"]);
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
