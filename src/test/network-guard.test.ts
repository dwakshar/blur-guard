// src/test/network-guard.test.ts
//
// Guard test for the v1 "on-device only" guarantee.
//
// FAIL CONDITION: Any failure here means image data COULD be sent to an external
// server, violating the "no data leaves your device" claim in the store listing.
//
// Architecture note: the test drives the SW through its message handler (same
// approach as roundtrip.test.ts) with chrome.storage pre-loaded with
// apiBackend: "sightengine" to simulate a user who had the cloud backend stored
// (e.g. from a dev session or a future v1.1 install downgraded to v1).

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlurGuardState, ClassifyRequestMessage } from "../types/messages";
import { CLOUD_BACKEND_ENABLED } from "../lib/featureFlags";
import { resetMemoryStore } from "../lib/verdict-cache";

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 10));
}

// ── Chrome stub ───────────────────────────────────────────────────────────────
// Pre-load storage with apiBackend: "sightengine" to prove the SW overrides it.

const capturedHandlers: Array<
  (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void
> = [];

const runtimeMessages: Array<unknown> = [];

const storedState: Partial<BlurGuardState> = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  feed: [],
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  allowlist: [],
  apiBackend: "sightengine", // intentionally stale — SW must not honour this in v1
};

vi.stubGlobal("chrome", {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onMessage: {
      addListener: (handler: (typeof capturedHandlers)[0]) => {
        capturedHandlers.push(handler);
      },
    },
    getContexts: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      runtimeMessages.push(msg);
      const m = msg as { type: string; payload?: { id: string } };
      if (m.type === "OFFSCREEN_PING") {
        return Promise.resolve({ type: "OFFSCREEN_READY" });
      }
      if (m.type === "OFFSCREEN_CLASSIFY") {
        // Simulate a successful on-device classify response.
        return Promise.resolve({
          id: m.payload!.id,
          predictions: [
            { className: "Neutral", probability: 0.95 },
            { className: "Drawing", probability: 0.02 },
            { className: "Sexy",    probability: 0.01 },
            { className: "Porn",    probability: 0.01 },
            { className: "Hentai",  probability: 0.01 },
          ],
          inferenceMs: 5,
          queueWaitMs: 0,
          decodeMs: 0,
        });
      }
      return Promise.resolve({ ok: true });
    }),
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
  },
  offscreen: {
    createDocument: vi.fn().mockResolvedValue(undefined),
    Reason: { BLOBS: "BLOBS", DOM_SCRAPING: "DOM_SCRAPING" },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation(() =>
        Promise.resolve({ blurguard: storedState })
      ),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
});

beforeAll(async () => {
  await import("../background");
});

beforeEach(() => {
  runtimeMessages.length = 0;
  resetMemoryStore();
  vi.mocked(chrome.offscreen.createDocument).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
});

function dispatchToSW(msg: unknown): Promise<unknown> {
  const handler = capturedHandlers[0];
  if (!handler) throw new Error("No handler — background.ts did not load");
  return new Promise((resolve) => handler(msg, { tab: { id: 42 } }, resolve));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("v1 network guard — no data leaves device", () => {
  // ── 1. Build-time constant ────────────────────────────────────────────────
  // Vite replaces __CLOUD_ENABLED__ with `false` before bundling.
  // If this test fails, the define in vite.config.ts was removed or flipped.
  it("CLOUD_BACKEND_ENABLED is false (build-time constant)", () => {
    expect(CLOUD_BACKEND_ENABLED).toBe(false);
  });

  // ── 2. OFFSCREEN_CLASSIFY.backend is always "tfjs" ────────────────────────
  // Even when storage has apiBackend: "sightengine" saved (simulating a stale
  // preference), the SW's getState() coercion must override it to "tfjs".
  it("OFFSCREEN_CLASSIFY.backend is 'tfjs' even when storage holds 'sightengine'", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ng-1", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    const classifyMsgs = runtimeMessages.filter(
      (m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY"
    ) as { type: string; payload: { backend: string } }[];

    expect(classifyMsgs.length).toBeGreaterThan(0);
    for (const m of classifyMsgs) {
      expect(m.payload.backend).toBe("tfjs");
    }
  });

  // ── 3. No sightengineConfig is ever forwarded ─────────────────────────────
  // Credentials must never be forwarded to the offscreen doc in v1.
  // If this field appears, image bytes would be sent to api.sightengine.com.
  it("no sightengineConfig is ever forwarded to the offscreen doc", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ng-2", url: "https://example.com/img2.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    const classifyMsgs = runtimeMessages.filter(
      (m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY"
    ) as { type: string; payload: { sightengineConfig?: unknown } }[];

    expect(classifyMsgs.length).toBeGreaterThan(0);
    for (const m of classifyMsgs) {
      expect(m.payload.sightengineConfig).toBeUndefined();
    }
  });

  // ── 4. SET_API_BACKEND "sightengine" is a no-op ───────────────────────────
  // Even if the popup somehow sends this message (e.g. old popup HTML cached),
  // the SW must ignore it and subsequent CLASSIFY_REQUEST must still use "tfjs".
  it("SET_API_BACKEND 'sightengine' does not enable cloud — next classify uses tfjs", async () => {
    await dispatchToSW({ type: "SET_API_BACKEND", payload: "sightengine" });

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ng-3", url: "https://example.com/img3.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    const classifyMsgs = runtimeMessages.filter(
      (m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY"
    ) as { type: string; payload: { backend: string } }[];

    expect(classifyMsgs.length).toBeGreaterThan(0);
    for (const m of classifyMsgs) {
      expect(m.payload.backend).toBe("tfjs");
    }
  });

  // ── 5. GET_STATE always returns apiBackend "tfjs" ─────────────────────────
  it("GET_STATE.apiBackend is always 'tfjs' regardless of stored value", async () => {
    const state = (await dispatchToSW({ type: "GET_STATE" })) as BlurGuardState;
    expect(state.apiBackend).toBe("tfjs");
  });
});
