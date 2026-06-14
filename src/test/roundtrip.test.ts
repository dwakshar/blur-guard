// src/test/roundtrip.test.ts
//
// Phase 0.7 smoke-test: verifies the full CLASSIFY_REQUEST → OFFSCREEN_CLASSIFY
// → CLASSIFY_RESULT → BLUR_DECISION round-trip without loading TF.js or a browser.
//
// Strategy:
//   1. Stub globalThis.chrome BEFORE background.ts is loaded (module-level vi.stubGlobal).
//   2. Dynamically import background.ts in beforeAll — it registers its onMessage handler
//      against the stub, which we capture.
//   3. Drive tests by calling dispatchToSW(), which invokes the captured handler directly.
//   4. Assert on what chrome.tabs.sendMessage and chrome.runtime.sendMessage received.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BlurDecisionMessage,
  ClassifyRequestMessage,
  Prediction,
} from "../types/messages";
import { verdictFromPredictions } from "../lib/classifier";

// ── Chrome API stub ───────────────────────────────────────────────────────────
// Set up at module level so the stub is in place when background.ts is dynamically
// imported in beforeAll. vi.stubGlobal runs synchronously before any beforeAll hook.

const capturedHandlers: Array<
  (
    msg: unknown,
    sender: unknown,
    sendResponse: (r: unknown) => void
  ) => boolean | void
> = [];

const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
const runtimeMessages: Array<unknown> = [];
let offscreenDocCount = 0;

// Overridden per test for explicit/safe scenarios.
let nextOffscreenPredictions: Prediction[] = safePredictions();

function safePredictions(): Prediction[] {
  return [
    { className: "Neutral", probability: 0.95 },
    { className: "Drawing", probability: 0.02 },
    { className: "Sexy",    probability: 0.01 },
    { className: "Porn",    probability: 0.01 },
    { className: "Hentai",  probability: 0.01 },
  ];
}

function explicitPredictions(): Prediction[] {
  return [
    { className: "Porn",    probability: 0.92 },
    { className: "Hentai",  probability: 0.03 },
    { className: "Sexy",    probability: 0.02 },
    { className: "Neutral", probability: 0.02 },
    { className: "Drawing", probability: 0.01 },
  ];
}

// Mutable state blob — tests can mutate fields before dispatching.
const storedState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced" as const,
  feed: [] as unknown[],
  stats: { images: 0, videos: 0, blocked: 0 },
};

// Whether to report an existing offscreen doc (simulates a doc already created).
let offscreenAlreadyExists = false;

vi.stubGlobal("chrome", {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onMessage: {
      addListener: (
        handler: (typeof capturedHandlers)[0]
      ) => {
        capturedHandlers.push(handler);
      },
    },
    getContexts: vi.fn().mockImplementation(() =>
      Promise.resolve(
        offscreenAlreadyExists
          ? [{ contextType: "OFFSCREEN_DOCUMENT" }]
          : []
      )
    ),
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      runtimeMessages.push(msg);
      const m = msg as { type: string; payload?: { id: string } };
      if (m.type === "OFFSCREEN_CLASSIFY") {
        return Promise.resolve({
          id: m.payload!.id,
          predictions: nextOffscreenPredictions,
          ms: 7, // stub SW-reported inference time
        });
      }
      // STATE_UPDATED and other broadcasts
      return Promise.resolve({ ok: true });
    }),
    ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
  },
  offscreen: {
    createDocument: vi.fn().mockImplementation(() => {
      offscreenDocCount++;
      return Promise.resolve();
    }),
    Reason: { BLOBS: "BLOBS", DOM_SCRAPING: "DOM_SCRAPING" },
  },
  tabs: {
    query: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockImplementation((tabId: number, msg: unknown) => {
      tabMessages.push({ tabId, msg });
      return Promise.resolve();
    }),
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

// ── Load background module ────────────────────────────────────────────────────

beforeAll(async () => {
  await import("../background");
  // background.ts calls chrome.runtime.onMessage.addListener at module level,
  // so capturedHandlers[0] is now the SW message dispatcher.
});

beforeEach(() => {
  tabMessages.length = 0;
  runtimeMessages.length = 0;
  offscreenDocCount = 0;
  offscreenAlreadyExists = false;
  nextOffscreenPredictions = safePredictions();
  storedState.enabled = true;
  storedState.pausedUntil = 0;
  storedState.sensitivity = "balanced";
  vi.mocked(chrome.offscreen.createDocument).mockClear();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
});

// ── Helper ────────────────────────────────────────────────────────────────────

function dispatchToSW(
  msg: unknown,
  sender: { tab?: { id: number } } = { tab: { id: 42 } }
): Promise<unknown> {
  const handler = capturedHandlers[0];
  if (!handler) throw new Error("No handler captured — background.ts did not load");
  return new Promise((resolve) => {
    handler(msg, sender, resolve);
  });
}

function sentBlurDecision(id?: string): BlurDecisionMessage | undefined {
  const match = tabMessages.find(({ msg }) => {
    const m = msg as BlurDecisionMessage;
    return m.type === "BLUR_DECISION" && (id == null || m.payload.id === id);
  });
  return match?.msg as BlurDecisionMessage | undefined;
}

// ── Round-trip integration tests ──────────────────────────────────────────────

describe("CLASSIFY_REQUEST → BLUR_DECISION round-trip", () => {
  it("creates exactly one offscreen document per CLASSIFY_REQUEST", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "rt-1", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    expect(offscreenDocCount).toBe(1);
  });

  it("does NOT create a second doc when one already exists", async () => {
    offscreenAlreadyExists = true;

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "rt-2", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    expect(offscreenDocCount).toBe(0);
  });

  it("forwards OFFSCREEN_CLASSIFY to runtime.sendMessage", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "rt-3", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const forwarded = runtimeMessages.find(
      (m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY"
    ) as { type: string; payload: { id: string; url: string; kind: string } };

    expect(forwarded).toBeDefined();
    expect(forwarded.payload.id).toBe("rt-3");
    expect(forwarded.payload.url).toBe("https://example.com/img.jpg");
    expect(forwarded.payload.kind).toBe("image");
  });

  it("sends BLUR_DECISION to the originating tab", async () => {
    await dispatchToSW(
      {
        type: "CLASSIFY_REQUEST",
        payload: { id: "rt-4", url: "https://example.com/img.jpg", kind: "image" },
      } satisfies ClassifyRequestMessage,
      { tab: { id: 77 } }
    );

    const decision = sentBlurDecision("rt-4");
    expect(decision).toBeDefined();
    const target = tabMessages.find(
      ({ msg }) => (msg as BlurDecisionMessage).type === "BLUR_DECISION"
    );
    expect(target?.tabId).toBe(77);
  });

  it("BLUR_DECISION carries the id from the original request", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "my-unique-id", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("my-unique-id");
    expect(decision?.payload.id).toBe("my-unique-id");
  });

  it("carries the offscreen-reported inference ms through to BLUR_DECISION", async () => {
    // Temporarily replace the sendMessage mock to return ms=123
    vi.mocked(chrome.runtime.sendMessage).mockImplementationOnce((msg: unknown) => {
      const m = msg as { type: string; payload?: { id: string } };
      if (m.type === "OFFSCREEN_CLASSIFY") {
        return Promise.resolve({ id: m.payload!.id, predictions: safePredictions(), ms: 123 });
      }
      return Promise.resolve({ ok: true });
    });

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ms-test", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("ms-test");
    expect(decision?.payload.ms).toBe(123);
  });

  it("verdict.shouldBlock is false for safe stub predictions", async () => {
    // nextOffscreenPredictions is already safe (set in beforeEach)
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "safe-rt", url: "https://example.com/safe.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("safe-rt");
    expect(decision?.payload.verdict.shouldBlock).toBe(false);
    expect(decision?.payload.verdict.category).toBe("safe");
  });

  it("verdict.shouldBlock is true for explicit predictions", async () => {
    nextOffscreenPredictions = explicitPredictions();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "nsfw-rt", url: "https://example.com/nsfw.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("nsfw-rt");
    expect(decision?.payload.verdict.shouldBlock).toBe(true);
    expect(decision?.payload.verdict.category).toBe("explicit");
    expect(decision?.payload.verdict.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("sends STATE_UPDATED when the verdict is blocking", async () => {
    nextOffscreenPredictions = explicitPredictions();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "block-state", url: "https://example.com/nsfw.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const stateMsg = runtimeMessages.find(
      (m) => (m as { type: string }).type === "STATE_UPDATED"
    );
    expect(stateMsg).toBeDefined();
  });

  it("does NOT send STATE_UPDATED for safe content", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "safe-state", url: "https://example.com/safe.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    const stateMsg = runtimeMessages.find(
      (m) => (m as { type: string }).type === "STATE_UPDATED"
    );
    expect(stateMsg).toBeUndefined();
  });

  it("does nothing when the extension is disabled", async () => {
    storedState.enabled = false;

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "disabled-rt", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    expect(sentBlurDecision("disabled-rt")).toBeUndefined();
    expect(offscreenDocCount).toBe(0);
  });

  it("does nothing when the extension is paused", async () => {
    storedState.pausedUntil = Date.now() + 60_000;

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "paused-rt", url: "https://example.com/img.jpg", kind: "image" },
    } satisfies ClassifyRequestMessage);

    expect(sentBlurDecision("paused-rt")).toBeUndefined();
  });
});

// ── verdictFromPredictions unit tests ─────────────────────────────────────────

describe("verdictFromPredictions", () => {
  it("safe for neutral-dominant output", () => {
    const v = verdictFromPredictions(safePredictions(), "balanced");
    expect(v.shouldBlock).toBe(false);
    expect(v.category).toBe("safe");
    expect(v.confidence).toBeGreaterThanOrEqual(0);
  });

  it("blocks explicit content at balanced sensitivity (Porn ≥ 0.90)", () => {
    const v = verdictFromPredictions(explicitPredictions(), "balanced");
    expect(v.shouldBlock).toBe(true);
    expect(v.category).toBe("explicit");
    expect(v.reasons).toContain("porn classification");
  });

  it("strict sensitivity blocks at lower Porn threshold (≥ 0.82)", () => {
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.84 },
      { className: "Hentai",  probability: 0.01 },
      { className: "Sexy",    probability: 0.03 },
      { className: "Neutral", probability: 0.11 },
      { className: "Drawing", probability: 0.01 },
    ];
    const v = verdictFromPredictions(preds, "strict");
    expect(v.shouldBlock).toBe(true);
  });

  it("low sensitivity does NOT block at 0.88 Porn (threshold 0.94)", () => {
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.88 },
      { className: "Hentai",  probability: 0.01 },
      { className: "Sexy",    probability: 0.03 },
      { className: "Neutral", probability: 0.07 },
      { className: "Drawing", probability: 0.01 },
    ];
    const v = verdictFromPredictions(preds, "low");
    // 0.89 < 0.94 low threshold → no block
    expect(v.shouldBlock).toBe(false);
  });

  it("combines Porn + Hentai for explicit score", () => {
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.52 },
      { className: "Hentai",  probability: 0.44 },
      { className: "Sexy",    probability: 0.01 },
      { className: "Neutral", probability: 0.02 },
      { className: "Drawing", probability: 0.01 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    // Combined = 0.96 ≥ 0.90 → explicit
    expect(v.category).toBe("explicit");
    expect(v.shouldBlock).toBe(true);
    expect(v.reasons).toContain("porn classification");
    expect(v.reasons).toContain("hentai classification");
  });

  it("classifies Sexy-dominant output as suggestive under balanced", () => {
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.62 },
      { className: "Neutral", probability: 0.28 },
      { className: "Drawing", probability: 0.04 },
      { className: "Porn",    probability: 0.04 },
      { className: "Hentai",  probability: 0.02 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    expect(v.category).toBe("suggestive");
    // suggestiveBlockThreshold for balanced = 0.72; 0.62 < 0.72 → no block
    expect(v.shouldBlock).toBe(false);
  });

  it("blocks suggestive above suggestiveBlockThreshold under strict", () => {
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.62 },
      { className: "Neutral", probability: 0.28 },
      { className: "Drawing", probability: 0.04 },
      { className: "Porn",    probability: 0.04 },
      { className: "Hentai",  probability: 0.02 },
    ];
    const v = verdictFromPredictions(preds, "strict");
    // suggestiveBlockThreshold for strict = 0.58; 0.62 ≥ 0.58 → block
    expect(v.shouldBlock).toBe(true);
    expect(v.category).toBe("suggestive");
  });
});
