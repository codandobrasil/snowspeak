import type { RuntimeMessage } from "../messaging";
import { captureMic, captureTab } from "./capture";
import { SessionController } from "./session-controller";
import { SessionStore } from "./session-store";
import { openBrowserSocket } from "./socket";

const store = new SessionStore();
const controller = new SessionController({ store, captureTab, captureMic, openSocket: openBrowserSocket });

store.subscribe((state) => {
  const message: RuntimeMessage = { target: "sidepanel", type: "state", state };
  // O painel pode estar fechado; nesse caso não há receptor.
  chrome.runtime.sendMessage(message).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  switch (message.type) {
    case "start":
      void controller.start(message.params);
      break;
    case "stop":
      controller.stop();
      break;
    case "get-state":
      sendResponse(store.snapshot());
      break;
  }
});
