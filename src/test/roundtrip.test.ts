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
      if (m.type === "OFFSCREEN_PING") {
        return Promise.resolve({ type: "OFFSCREEN_READY" });
      }
      if (m.type === "OFFSCREEN_CLASSIFY") {
        return Promise.resolve({
          id: m.payload!.id,
          predictions: nextOffscreenPredictions,
          inferenceMs: 7,
          queueWaitMs: 0,
          decodeMs: 0,
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
      payload: { id: "rt-1", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    expect(offscreenDocCount).toBe(1);
  });

  it("does NOT create a second doc when one already exists", async () => {
    offscreenAlreadyExists = true;

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "rt-2", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    expect(offscreenDocCount).toBe(0);
  });

  it("forwards OFFSCREEN_CLASSIFY to runtime.sendMessage", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "rt-3", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
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
        payload: { id: "rt-4", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
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
      payload: { id: "my-unique-id", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("my-unique-id");
    expect(decision?.payload.id).toBe("my-unique-id");
  });

  it("carries the offscreen-reported inference ms through to BLUR_DECISION", async () => {
    // PING is always the first sendMessage call (waitForOffscreenReady). Chain two
    // mockImplementationOnce so the first slot handles PING and the second returns
    // inferenceMs:123 for CLASSIFY. Without the first slot, PING would consume the
    // custom CLASSIFY handler and CLASSIFY would fall through to the base mock (7ms).
    vi.mocked(chrome.runtime.sendMessage)
      .mockImplementationOnce(() => Promise.resolve({ type: "OFFSCREEN_READY" }))
      .mockImplementationOnce((msg: unknown) => {
        const m = msg as { type: string; payload?: { id: string } };
        if (m.type === "OFFSCREEN_CLASSIFY") {
          return Promise.resolve({ id: m.payload!.id, predictions: safePredictions(), inferenceMs: 123, queueWaitMs: 0, decodeMs: 0 });
        }
        return Promise.resolve({ ok: true });
      });

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ms-test", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("ms-test");
    expect(decision?.payload.inferenceMs).toBe(123);
  });

  it("verdict.shouldBlock is false for safe stub predictions", async () => {
    // nextOffscreenPredictions is already safe (set in beforeEach)
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "safe-rt", url: "https://example.com/safe.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("safe-rt");
    expect(decision?.payload.verdict.shouldBlock).toBe(false);
    expect(decision?.payload.verdict.category).toBe("safe");
  });

  it("verdict.shouldBlock is true for explicit predictions", async () => {
    nextOffscreenPredictions = explicitPredictions();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "nsfw-rt", url: "https://example.com/nsfw.jpg", kind: "image", priority: "high" },
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
      payload: { id: "block-state", url: "https://example.com/nsfw.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    const stateMsg = runtimeMessages.find(
      (m) => (m as { type: string }).type === "STATE_UPDATED"
    );
    expect(stateMsg).toBeDefined();
  });

  it("does NOT send STATE_UPDATED for safe content", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "safe-state", url: "https://example.com/safe.jpg", kind: "image", priority: "high" },
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
      payload: { id: "disabled-rt", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    expect(sentBlurDecision("disabled-rt")).toBeUndefined();
    expect(offscreenDocCount).toBe(0);
  });

  it("does nothing when the extension is paused", async () => {
    storedState.pausedUntil = Date.now() + 60_000;

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "paused-rt", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
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

  it("blocks explicit content at balanced sensitivity (Porn+Hentai sum ≥ 0.45)", () => {
    // explicitPredictions(): Porn=0.92, Hentai=0.03 → sum=0.95 ≥ 0.45 balanced threshold
    const v = verdictFromPredictions(explicitPredictions(), "balanced");
    expect(v.shouldBlock).toBe(true);
    expect(v.category).toBe("explicit");
    expect(v.reasons).toContain("porn classification");
  });

  it("strict catches lower explicit sums that balanced misses (strict=0.35 vs balanced=0.45)", () => {
    // sum=0.40: above strict(0.35) but below balanced(0.45) — strict-only territory
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.38 },
      { className: "Hentai",  probability: 0.02 },
      { className: "Sexy",    probability: 0.02 },
      { className: "Neutral", probability: 0.54 },
      { className: "Drawing", probability: 0.04 },
    ];
    const vStrict = verdictFromPredictions(preds, "strict");
    expect(vStrict.shouldBlock).toBe(true);
    expect(vStrict.category).toBe("explicit");

    const vBalanced = verdictFromPredictions(preds, "balanced");
    // 0.40 < 0.45 balanced threshold; Sexy=0.02 < suggestiveThreshold → safe
    expect(vBalanced.shouldBlock).toBe(false);
  });

  it("low sensitivity does NOT block moderate combined scores that balanced catches", () => {
    // sum=0.50: above balanced(0.45) but below low(0.60) — balanced catches, low does not
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.35 },
      { className: "Hentai",  probability: 0.15 },
      { className: "Sexy",    probability: 0.15 },
      { className: "Neutral", probability: 0.30 },
      { className: "Drawing", probability: 0.05 },
    ];
    const vLow = verdictFromPredictions(preds, "low");
    // 0.50 < 0.60 low threshold; Sexy=0.15 < 0.68 low suggestiveThreshold → safe
    expect(vLow.shouldBlock).toBe(false);

    const vBalanced = verdictFromPredictions(preds, "balanced");
    // 0.50 ≥ 0.45 balanced threshold → explicit
    expect(vBalanced.shouldBlock).toBe(true);
    expect(vBalanced.category).toBe("explicit");
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
    // Combined = 0.96 ≥ 0.45 balanced threshold → explicit
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
      { className: "Sexy",    probability: 0.70 },
      { className: "Neutral", probability: 0.10 },
      { className: "Drawing", probability: 0.04 },
      { className: "Porn",    probability: 0.12 },
      { className: "Hentai",  probability: 0.04 },
    ];
    const v = verdictFromPredictions(preds, "strict");
    // Porn+Hentai=0.16 < 0.35 explicitThreshold; Sexy=0.70 ≥ 0.46 suggestiveThreshold
    // margin = 0.70 - 0.10 = 0.60 ≥ 0.06 sexyNeutralMargin; 0.70 ≥ 0.65 blockThreshold → block
    expect(v.shouldBlock).toBe(true);
    expect(v.category).toBe("suggestive");
  });

  // ── Phase 2.4 threshold regression tests ─────────────────────────────────────
  // These lock in the tuned thresholds. Any change to SENSITIVITY_PROFILES will
  // break these tests intentionally, forcing a deliberate threshold decision.

  it("[2.4] yoga/fitness FP (balanced): Sexy=0.73 Neutral=0.22 → suggestive, NOT blocked", () => {
    // Was blocked before 2.4 (old suggestiveBlockThreshold=0.72; 0.73 ≥ 0.72 → block).
    // Now: 0.73 < 0.78 new blockThreshold → no block.
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.73 },
      { className: "Neutral", probability: 0.22 },
      { className: "Drawing", probability: 0.02 },
      { className: "Porn",    probability: 0.02 },
      { className: "Hentai",  probability: 0.01 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    expect(v.category).toBe("suggestive");   // still flagged (informational)
    expect(v.shouldBlock).toBe(false);        // not blocked ← FP fixed
  });

  it("[2.4] yoga/fitness FP (strict): Sexy=0.63 Neutral=0.24 → suggestive, NOT blocked", () => {
    // Was blocked before 2.4 (old suggestiveBlockThreshold=0.58; 0.63 ≥ 0.58 → block).
    // Now: 0.63 < 0.65 new blockThreshold → no block.
    // margin = 0.63 - 0.24 = 0.39 ≥ 0.06 sexyNeutralMargin → still suggestive.
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.63 },
      { className: "Neutral", probability: 0.24 },
      { className: "Drawing", probability: 0.05 },
      { className: "Porn",    probability: 0.05 },
      { className: "Hentai",  probability: 0.03 },
    ];
    const v = verdictFromPredictions(preds, "strict");
    expect(v.category).toBe("suggestive");
    expect(v.shouldBlock).toBe(false);
  });

  it("[2.4] margin gate: high Neutral suppresses suggestive verdict (balanced)", () => {
    // Sexy ≥ suggestiveThreshold but Neutral ≈ Sexy → margin too small → safe.
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.62 },
      { className: "Neutral", probability: 0.55 },
      { className: "Drawing", probability: 0.02 },
      { className: "Porn",    probability: 0.01 },
      { className: "Hentai",  probability: 0.00 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    // margin = 0.62 - 0.55 = 0.07 < 0.12 sexyNeutralMargin → safe
    expect(v.category).toBe("safe");
    expect(v.shouldBlock).toBe(false);
  });

  it("[2.4] genuine suggestive still blocks at balanced (Sexy=0.80 Neutral=0.07)", () => {
    // Tradeoff check: raising the block threshold must not produce FNs here.
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.80 },
      { className: "Neutral", probability: 0.07 },
      { className: "Drawing", probability: 0.03 },
      { className: "Porn",    probability: 0.07 },
      { className: "Hentai",  probability: 0.03 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    // margin = 0.73 ≥ 0.12; 0.80 ≥ 0.78 blockThreshold → block
    expect(v.category).toBe("suggestive");
    expect(v.shouldBlock).toBe(true);
  });

  it("[2.4] genuine suggestive still blocks at strict (Sexy=0.68 Neutral=0.09)", () => {
    const preds: Prediction[] = [
      { className: "Sexy",    probability: 0.68 },
      { className: "Neutral", probability: 0.09 },
      { className: "Drawing", probability: 0.04 },
      { className: "Porn",    probability: 0.12 },
      { className: "Hentai",  probability: 0.07 },
    ];
    const v = verdictFromPredictions(preds, "strict");
    // Porn+Hentai=0.19 < 0.35 strict explicit threshold; Sexy=0.68 ≥ 0.46; margin=0.59 ≥ 0.06; 0.68 ≥ 0.65 → block
    expect(v.category).toBe("suggestive");
    expect(v.shouldBlock).toBe(true);
  });

  it("[2.4-redo] high combined score (sum=0.97) blocks at all sensitivities", () => {
    // Porn=0.95, Hentai=0.02 → sum=0.97 clears strict(0.35), balanced(0.45), low(0.60)
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.95 },
      { className: "Hentai",  probability: 0.02 },
      { className: "Sexy",    probability: 0.01 },
      { className: "Neutral", probability: 0.01 },
      { className: "Drawing", probability: 0.01 },
    ];
    for (const s of ["strict", "balanced", "low"] as const) {
      const v = verdictFromPredictions(preds, s);
      expect(v.category).toBe("explicit");
      expect(v.shouldBlock).toBe(true);
    }
  });

  it("[2.4-redo] sum=0.52 blocks at strict+balanced, NOT at low (tier boundary demo)", () => {
    // sum=0.52: above strict(0.35) and balanced(0.45), below low(0.60)
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.45 },
      { className: "Hentai",  probability: 0.07 },
      { className: "Sexy",    probability: 0.07 },
      { className: "Neutral", probability: 0.35 },
      { className: "Drawing", probability: 0.06 },
    ];
    // strict(0.35): 0.52 ≥ 0.35 → explicit
    expect(verdictFromPredictions(preds, "strict").shouldBlock).toBe(true);
    // balanced(0.45): 0.52 ≥ 0.45 → explicit
    expect(verdictFromPredictions(preds, "balanced").shouldBlock).toBe(true);
    // low(0.60): 0.52 < 0.60; Sexy=0.07 < 0.68 low suggestiveThreshold → safe
    expect(verdictFromPredictions(preds, "low").shouldBlock).toBe(false);
  });

  it("[2.4-redo] real FN fix: Hentai-dominant sum=0.84 → explicit at balanced", () => {
    // Mirrors nsfw-01 from real browser run: Hentai=0.823, Porn=0.016 → sum=0.839
    // Was FN under old threshold 0.90; now caught at 0.45.
    const preds: Prediction[] = [
      { className: "Hentai",  probability: 0.823 },
      { className: "Porn",    probability: 0.016 },
      { className: "Sexy",    probability: 0.042 },
      { className: "Neutral", probability: 0.108 },
      { className: "Drawing", probability: 0.011 },
    ];
    const v = verdictFromPredictions(preds, "balanced");
    expect(v.category).toBe("explicit");
    expect(v.shouldBlock).toBe(true);
    expect(v.reasons).toContain("hentai classification");
  });

  it("[2.4-redo] real FN fix: lower sum=0.66 → explicit at balanced and strict", () => {
    // Mirrors nsfw-02 from real browser run: sum≈0.659
    // Was FN at both balanced(0.90) and strict(0.82); now caught at 0.45/0.35.
    const preds: Prediction[] = [
      { className: "Porn",    probability: 0.55 },
      { className: "Hentai",  probability: 0.11 },
      { className: "Sexy",    probability: 0.10 },
      { className: "Neutral", probability: 0.20 },
      { className: "Drawing", probability: 0.04 },
    ];
    expect(verdictFromPredictions(preds, "balanced").shouldBlock).toBe(true);
    expect(verdictFromPredictions(preds, "strict").shouldBlock).toBe(true);
    // sum=0.66 ≥ 0.60 low threshold — also caught at low
    expect(verdictFromPredictions(preds, "low").shouldBlock).toBe(true);
  });

  it("[2.4-redo] model ceiling: Drawing-dominant with near-zero Porn/Hentai → safe at all tiers", () => {
    // Mirrors nsfw-04 from real browser run: Drawing=0.968, Porn≈0.004, Hentai≈0.002
    // NSFWJS does not assign Porn/Hentai probability — sum≈0.006 far below any threshold.
    // This is a model ceiling, not a bug. Sightengine (cloud) catches this image.
    // Do NOT special-case this — it would produce FPs on legitimate illustrated content.
    const preds: Prediction[] = [
      { className: "Drawing", probability: 0.968 },
      { className: "Neutral", probability: 0.018 },
      { className: "Sexy",    probability: 0.008 },
      { className: "Porn",    probability: 0.004 },
      { className: "Hentai",  probability: 0.002 },
    ];
    for (const s of ["strict", "balanced", "low"] as const) {
      const v = verdictFromPredictions(preds, s);
      expect(v.category).toBe("safe");
      expect(v.shouldBlock).toBe(false);
    }
  });
});
