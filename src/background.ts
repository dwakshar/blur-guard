// BlurGuard background service worker for MV3.
// Owns extension state, offscreen document lifecycle, and the classify round-trip.

import type {
  BlurGuardMessage,
  BlurGuardState,
  ClassifyResultMessage,
  DetectionEvent,
  DetectionReportPayload,
  Verdict,
} from "./types/messages";
import { assertNever } from "./types/messages";
import { verdictFromPredictions } from "./lib/classifier";

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

// ── Offscreen document lifecycle ──────────────────────────────────────────────
// Only one offscreen doc may exist per extension at a time (Chrome limit).
// offscreenCreating serializes concurrent ensureOffscreen() calls so we never
// call createDocument() twice in the same SW lifetime.

let offscreenCreating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  // getContexts is the canonical check; hasDocument() was removed from the spec.
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  // If another concurrent call already started creation, await it.
  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  offscreenCreating = chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      // BLOBS: we fetch image bytes and call blob() on the Response.
      // DOM_SCRAPING: createImageBitmap + canvas drawing for ML preprocessing.
      // No explicit canvas/WebGL reason exists in the API; DOM_SCRAPING is the
      // accepted stand-in for ML workloads (see Chrome extension samples).
      reasons: [
        chrome.offscreen.Reason.BLOBS,
        chrome.offscreen.Reason.DOM_SCRAPING,
      ],
      justification:
        "Fetch image bytes as Blob and decode via createImageBitmap for ML inference " +
        "using canvas and WebGL — contexts unavailable in the service worker.",
    })
    .catch((err: unknown) => {
      // If the SW was terminated and restarted mid-flight, Chrome may report
      // "Only a single offscreen document may be created" even though our
      // getContexts check above returned 0. Treat this as success.
      if (
        err instanceof Error &&
        err.message.includes("Only a single offscreen")
      ) {
        return;
      }
      throw err;
    });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  const existing = await chrome.storage.local.get("blurguard");
  if (details.reason === "install" && !existing.blurguard) {
    await chrome.storage.local.set({ blurguard: DEFAULT_STATE });
    console.log("[BlurGuard] Initialized default state.");
  }
});

chrome.runtime.onMessage.addListener(
  (message: BlurGuardMessage, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse);
    return true;
  }
);

async function handleMessage(
  message: BlurGuardMessage,
  sender?: chrome.runtime.MessageSender
): Promise<unknown> {
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

    // ── Inference pipeline ────────────────────────────────────────────────────

    case "CLASSIFY_REQUEST": {
      const state = await getState();
      if (!state.enabled || state.pausedUntil > Date.now()) {
        return { ok: true };
      }

      const { id, url, kind } = message.payload;

      // Ensure the offscreen doc exists before forwarding.
      await ensureOffscreen();

      // Forward to offscreen doc and await the classify result.
      let raw: ClassifyResultMessage["payload"] | undefined;
      try {
        raw = (await chrome.runtime.sendMessage({
          type: "OFFSCREEN_CLASSIFY",
          payload: { id, url, kind },
        })) as ClassifyResultMessage["payload"];
      } catch (err) {
        console.error("[BlurGuard SW] offscreen classify error:", err);
        return { ok: true };
      }

      if (!raw?.predictions?.length) return { ok: true };

      console.log(
        `[BlurGuard SW] classify done — decode ${raw.decodeMs}ms  inference ${raw.inferenceMs}ms`
      );

      // Map predictions through sensitivity thresholds → Verdict.
      const verdict: Verdict = verdictFromPredictions(
        raw.predictions,
        state.sensitivity
      );

      // Send BLUR_DECISION to the originating tab's content script.
      const tabId = sender?.tab?.id;
      if (tabId !== undefined) {
        chrome.tabs
          .sendMessage(tabId, {
            type: "BLUR_DECISION",
            payload: { id, verdict, inferenceMs: raw.inferenceMs, decodeMs: raw.decodeMs },
          })
          .catch(() => {
            // Tab may have navigated away before the round-trip completed.
          });
      }

      // Persist to feed and push STATE_UPDATED only when blocking, matching the
      // REPORT_DETECTION behavior (content script only reports blocked items).
      if (verdict.shouldBlock) {
        const nextState = buildNextState(
          state, id, url, kind, verdict, raw.inferenceMs, raw.decodeMs
        );
        await chrome.storage.local.set({ blurguard: nextState });
        await notifyPopup(nextState);
      }

      return { ok: true };
    }

    // SW sends these; it does not receive them. No-op to keep switch exhaustive.
    case "OFFSCREEN_CLASSIFY":
    case "CLASSIFY_RESULT":
    case "BLUR_DECISION":
      return { ok: true };

    // Offscreen lifecycle — SW sends OFFSCREEN_PING; offscreen sends OFFSCREEN_READY.
    // Neither needs SW-side handling beyond an ACK.
    case "OFFSCREEN_PING":
    case "OFFSCREEN_READY":
      return { ok: true };

    default:
      return assertNever(message);
  }
}

// ── State helpers ─────────────────────────────────────────────────────────────

function buildNextState(
  state: BlurGuardState,
  id: string,
  url: string,
  kind: "image" | "video",
  verdict: Verdict,
  inferenceMs: number,
  decodeMs: number,
): BlurGuardState {
  let domain = "unknown";
  try {
    domain = new URL(url).hostname;
  } catch {
    // Malformed or data: URL — keep "unknown".
  }

  const event: DetectionEvent = {
    id,
    kind,
    src: url,
    domain,
    category: verdict.category,
    confidence: verdict.confidence,
    reasons: verdict.reasons,
    timestamp: Date.now(),
    inferenceMs,
    decodeMs,
  };

  return {
    ...state,
    feed: [event, ...state.feed].slice(0, 20),
    stats: {
      ...state.stats,
      images: kind === "image" ? state.stats.images + 1 : state.stats.images,
      videos: kind === "video" ? state.stats.videos + 1 : state.stats.videos,
      blocked: state.stats.blocked + 1,
    },
  };
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
