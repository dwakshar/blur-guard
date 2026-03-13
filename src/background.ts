// BlurGuard — Background Service Worker (MV3)
// Runs as a persistent-less service worker. Re-initializes on each wake.

import type { BlurGuardMessage, BlurGuardState } from "./types/messages";

const DEFAULT_STATE: BlurGuardState = {
  enabled: true,
  sensitivity: "balanced",
  feed: [],
  stats: {
    images: 0,
    videos: 0,
    blocked: 0,
  },
};

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get("blurguard");
  if (!existing.blurguard) {
    await chrome.storage.local.set({ blurguard: DEFAULT_STATE });
    console.log("[BlurGuard] Initialized default state.");
  }
});

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (message: BlurGuardMessage, _sender, sendResponse) => {
    handleMessage(message).then(sendResponse);
    return true; // keep channel open for async response
  }
);

async function handleMessage(message: BlurGuardMessage): Promise<unknown> {
  const { type, payload } = message;

  switch (type) {
    case "GET_STATE": {
      const data = await chrome.storage.local.get("blurguard");
      return data.blurguard ?? DEFAULT_STATE;
    }

    case "SET_ENABLED": {
      await updateState({ enabled: payload as boolean });
      await broadcastToAllTabs({ type: "PROTECTION_TOGGLED", payload });
      return { ok: true };
    }

    case "SET_SENSITIVITY": {
      await updateState({
        sensitivity: payload as BlurGuardState["sensitivity"],
      });
      await broadcastToAllTabs({ type: "SENSITIVITY_CHANGED", payload });
      return { ok: true };
    }

    case "REPORT_DETECTION": {
      const state = await getState();
      const detection = payload as { kind: "image" | "video" };

      const updated: BlurGuardState = {
        ...state,
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
      await chrome.storage.local.set({ blurguard: updated });
      return { ok: true };
    }

    default:
      return { error: `Unknown message type: ${type}` };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
        // Tab may not have content script — ignore silently
      });
    }
  }
}

async function getState(): Promise<BlurGuardState> {
  const result = await chrome.storage.local.get("blurguard");
  const data = await chrome.storage.local.get("blurguard");
  if (!result.blurguard) {
    await chrome.storage.local.set({ blurguard: DEFAULT_STATE });
    return DEFAULT_STATE;
  }

  return (data.blurguard as BlurGuardState | undefined) ?? DEFAULT_STATE;
}
