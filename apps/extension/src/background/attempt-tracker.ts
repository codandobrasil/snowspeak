// Identifica cada tentativa de início no service worker. Parar invalida a tentativa em qualquer
// etapa anterior ao controlador (criação do offscreen, obtenção do streamId); cada etapa confere
// isCurrent() depois de cada await.
export class AttemptTracker {
  private counter = 0;
  private pending: number | null = null;

  /** Retorna o id da nova tentativa, ou null se já existe uma pendente. */
  begin(): number | null {
    if (this.pending !== null) return null;
    this.counter += 1;
    this.pending = this.counter;
    return this.counter;
  }

  isCurrent(id: number): boolean {
    return this.pending === id;
  }

  cancel(): void {
    this.pending = null;
  }

  finish(id: number): void {
    if (this.pending === id) this.pending = null;
  }
}
