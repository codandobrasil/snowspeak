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
  };
}
