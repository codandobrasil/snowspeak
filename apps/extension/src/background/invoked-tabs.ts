// Abas em que o usuário clicou no ícone do SnowSpeak: só elas podem ser capturadas.
// A lista é removida quando a aba fecha ou recarrega (a autorização do Chrome também se perde).

export const NOT_INVOKED_MESSAGE = "Clique no ícone do SnowSpeak nesta aba para autorizar a captura.";

export type CaptureTarget = { ok: true; tabId: number } | { ok: false; error: string };

export function addInvokedTab(tabs: readonly number[], tabId: number): number[] {
  return tabs.includes(tabId) ? [...tabs] : [...tabs, tabId];
}

export function removeInvokedTab(tabs: readonly number[], tabId: number): number[] {
  return tabs.filter((id) => id !== tabId);
}

/** Resolve a aba que o painel está mostrando; nunca cai para outra aba autorizada. */
export function resolveCaptureTab(invoked: readonly number[], activeTabId: number | undefined): CaptureTarget {
  if (activeTabId === undefined) return { ok: false, error: "Nenhuma aba ativa para capturar." };
  if (!invoked.includes(activeTabId)) return { ok: false, error: NOT_INVOKED_MESSAGE };
  return { ok: true, tabId: activeTabId };
}
