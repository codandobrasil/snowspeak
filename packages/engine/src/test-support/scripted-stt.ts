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
