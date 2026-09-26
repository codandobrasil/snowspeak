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
