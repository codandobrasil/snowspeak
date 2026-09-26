import type { SessionSettingsChanges, StartParams } from "./offscreen/session-controller";
import type { SessionState } from "./offscreen/session-store";

/** O painel não conhece o streamId: o service worker o obtém para a aba que o painel mostra (tabId). */
export type PanelStartParams = Omit<StartParams, "streamId">;

export type BackgroundMessage =
  | { target: "background"; type: "start"; params: PanelStartParams; tabId: number | undefined }
  | { target: "background"; type: "stop" };

export type OffscreenMessage =
  | { target: "offscreen"; type: "start"; params: StartParams }
  | { target: "offscreen"; type: "stop" }
  | { target: "offscreen"; type: "get-state" }
  | { target: "offscreen"; type: "suggest" }
  | { target: "offscreen"; type: "clear" }
  | { target: "offscreen"; type: "update"; changes: SessionSettingsChanges };

export type SidePanelMessage = { target: "sidepanel"; type: "state"; state: SessionState };

export type RuntimeMessage = BackgroundMessage | OffscreenMessage | SidePanelMessage;

export interface StartResponse {
  ok: boolean;
  /** A tentativa foi cancelada por um Parar antes de chegar ao offscreen. */
  cancelled?: boolean;
  error?: string;
}
