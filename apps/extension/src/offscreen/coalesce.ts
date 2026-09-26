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
