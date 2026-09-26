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
