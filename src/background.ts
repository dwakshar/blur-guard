// BlurGuard background service worker for MV3.
// Persists extension state and relays updates to popup/content scripts.

import type {
  BlurGuardMessage,
  BlurGuardState,
  DetectionEvent,
  DetectionReportPayload,
} from "./types/messages";

const DEFAULT_STATE: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  feed: [],
  stats: {
    images: 0,
    videos: 0,
    blocked: 0,
  },
};

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get("blurguard");
  if (details.reason === "install" && !existing.blurguard) {
    await chrome.storage.local.set({ blurguard: DEFAULT_STATE });
    console.log("[BlurGuard] Initialized default state.");
  }
});

chrome.runtime.onMessage.addListener(
  (message: BlurGuardMessage, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse);
    return true;
  }
);

async function handleMessage(message: BlurGuardMessage): Promise<unknown> {
  switch (message.type) {
    case "GET_STATE": {
      return getState();
    }

    case "RESET_STATS": {
      const current = await getState();
      const nextState: BlurGuardState = {
        ...current,
        feed: [],
        stats: { ...DEFAULT_STATE.stats },
      };
      await chrome.storage.local.set({ blurguard: nextState });
      await notifyPopup(nextState);
      return { ok: true };
    }

    case "SET_ENABLED": {
      const enabled = message.payload;
      await updateState({
        enabled,
        pausedUntil: enabled ? 0 : (await getState()).pausedUntil,
      });
      await broadcastToAllTabs({
        type: "PROTECTION_TOGGLED",
        payload: enabled,
      });
      await notifyPopup(await getState());
      return { ok: true };
    }

    case "SET_PAUSED": {
      const nextState: BlurGuardState = {
        ...(await getState()),
        enabled: false,
        pausedUntil: Date.now() + 5 * 60 * 1000,
      };
      await chrome.storage.local.set({ blurguard: nextState });
      await broadcastToAllTabs({ type: "PROTECTION_TOGGLED", payload: false });
      await notifyPopup(nextState);
      return { ok: true };
    }

    case "SET_SENSITIVITY": {
      await updateState({
        sensitivity: message.payload,
      });
      await broadcastToAllTabs({
        type: "SENSITIVITY_CHANGED",
        payload: message.payload,
      });
      await notifyPopup(await getState());
      return { ok: true };
    }

    case "REPORT_DETECTION": {
      const state = await getState();
      if (state.pausedUntil > Date.now()) {
        return { ok: true };
      }

      const detection: DetectionReportPayload = message.payload;
      let domain = "unknown";

      try {
        domain = new URL(detection.src).hostname;
      } catch {
        // Keep a safe fallback if the media source is missing or malformed.
      }

      const event: DetectionEvent = {
        id: crypto.randomUUID(),
        kind: detection.kind,
        src: detection.src,
        domain,
        category: detection.category,
        confidence: detection.confidence,
        reasons: detection.reasons,
        timestamp: Date.now(),
      };

      const nextState: BlurGuardState = {
        ...state,
        feed: [event, ...state.feed].slice(0, 20),
        stats: {
          ...state.stats,
          images:
            detection.kind === "image"
              ? state.stats.images + 1
              : state.stats.images,
          videos:
            detection.kind === "video"
              ? state.stats.videos + 1
              : state.stats.videos,
          blocked: state.stats.blocked + 1,
        },
      };
      await chrome.storage.local.set({ blurguard: nextState });
      await notifyPopup(nextState);
      return { ok: true };
    }

    case "STATE_UPDATED":
    case "PROTECTION_TOGGLED":
    case "SENSITIVITY_CHANGED":
      return { ok: true };
  }

  const exhaustiveCheck: never = message;
  return { error: `Unknown message type: ${String(exhaustiveCheck)}` };
}

async function updateState(partial: Partial<BlurGuardState>): Promise<void> {
  const current = await getState();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ blurguard: next });
}

async function broadcastToAllTabs(message: BlurGuardMessage): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Tab may not have the content script yet.
      });
    }
  }
}

async function getState(): Promise<BlurGuardState> {
  const data = await chrome.storage.local.get("blurguard");
  const stored = data.blurguard as Partial<BlurGuardState> | undefined;
  if (!stored) return DEFAULT_STATE;

  return {
    ...DEFAULT_STATE,
    ...stored,
    stats: {
      ...DEFAULT_STATE.stats,
      ...(stored.stats ?? {}),
    },
  };
}

async function notifyPopup(state: BlurGuardState): Promise<void> {
  await chrome.runtime
    .sendMessage({ type: "STATE_UPDATED", payload: state })
    .catch(() => {});
}
