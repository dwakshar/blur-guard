// src/test/preblur.test.ts
//
// Verifies the block-by-default pre-blur implementation (Phase 3).
//
// Two test groups:
//   1. Static artefacts — the document_start CSS file exists with correct rules,
//      and manifest.json declares it at run_at:"document_start".
//   2. SW fail-closed — when the offscreen doc returns neither predictions nor a
//      verdict (decode failure, queue drop, classify error), the SW does NOT send
//      BLUR_DECISION to the content tab.  The pre-blur CSS therefore remains in
//      place for that element — fail-closed.

import { readFileSync } from "fs";
import { resolve } from "path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifyRequestMessage, BlurDecisionMessage, Prediction } from "../types/messages";
import { resetMemoryStore } from "../lib/verdict-cache";

// ── 1. Static artefact tests ──────────────────────────────────────────────────

describe("document_start pre-blur artefacts", () => {
  const root = resolve(__dirname, "../../");

  it("preblur.css exists in public/ and declares the default blur rule", () => {
    const css = readFileSync(resolve(root, "public/preblur.css"), "utf-8");
    // Both selectors must be present
    expect(css).toContain("img:not(.bg-cleared)");
    expect(css).toContain("video:not(.bg-cleared)");
    // The blur value matches the overlay blur radius
    expect(css).toContain("blur(22px)");
    // Must be !important so page CSS cannot override it
    expect(css).toContain("!important");
  });

  it("manifest.json has a document_start entry injecting preblur.css", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "public/manifest.json"), "utf-8")
    ) as {
      content_scripts: Array<{
        matches: string[];
        css?: string[];
        js?: string[];
        run_at?: string;
      }>;
    };

    const docStartEntry = manifest.content_scripts.find(
      (cs) => cs.run_at === "document_start"
    );
    expect(docStartEntry, "no document_start content_script entry in manifest").toBeDefined();
    expect(docStartEntry!.css).toContain("preblur.css");
    // document_start entry should NOT inject JS (CSS only; JS runs at document_idle)
    expect(docStartEntry!.js).toBeUndefined();
  });

  it("document_idle JS entry is still present in manifest.json", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "public/manifest.json"), "utf-8")
    ) as {
      content_scripts: Array<{ js?: string[]; run_at?: string }>;
    };

    const idleEntry = manifest.content_scripts.find(
      (cs) => cs.run_at === "document_idle" && cs.js?.includes("content.js")
    );
    expect(idleEntry, "document_idle content.js entry missing").toBeDefined();
  });
});

// ── 2. SW fail-closed tests ───────────────────────────────────────────────────
//
// The pre-blur CSS keeps every element blurred until JS explicitly adds .bg-cleared.
// JS only adds .bg-cleared (via clearPreblur) when BLUR_DECISION arrives with
// shouldBlock=false.  If no BLUR_DECISION is ever sent, the element stays blurred.
//
// This test group verifies the SW side: when the offscreen doc returns a result
// with no predictions and no verdict (all three error paths trigger this), the SW
// must NOT send BLUR_DECISION to the tab.

const capturedHandlers: Array<
  (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void
> = [];
const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
const runtimeMessages: Array<unknown> = [];

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 10));
}

// What the mock offscreen returns for the next OFFSCREEN_CLASSIFY.
// Set to undefined predictions/verdict to simulate decode/classify errors.
let nextOffscreenResponse: Record<string, unknown> = {};

const storedState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced" as const,
  feed: [] as unknown[],
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  allowlist: [] as string[],
};

vi.stubGlobal("chrome", {
  runtime: {
    onInstalled: { addListener: vi.fn() },
    onMessage: {
      addListener: (handler: (typeof capturedHandlers)[0]) => {
        capturedHandlers.push(handler);
      },
    },
    getContexts: vi.fn().mockImplementation(() =>
      Promise.resolve([{ contextType: "OFFSCREEN_DOCUMENT" }])
    ),
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      runtimeMessages.push(msg);
      const m = msg as { type: string; payload?: { id: string } };
      if (m.type === "OFFSCREEN_PING") {
        return Promise.resolve({ type: "OFFSCREEN_READY" });
      }
      if (m.type === "OFFSCREEN_CLASSIFY") {
        // Return whatever nextOffscreenResponse is set to (may lack predictions/verdict).
        return Promise.resolve({ id: m.payload!.id, ...nextOffscreenResponse });
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

beforeAll(async () => {
  // background.ts registers its onMessage handler at module level.
  await import("../background");
});

beforeEach(() => {
  tabMessages.length = 0;
  runtimeMessages.length = 0;
  nextOffscreenResponse = {};
  resetMemoryStore();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
});

function dispatchToSW(
  msg: unknown,
  sender: { tab?: { id: number } } = { tab: { id: 42 } }
): Promise<unknown> {
  const handler = capturedHandlers[0];
  if (!handler) throw new Error("No SW handler captured — background.ts did not load");
  return new Promise((resolve) => { handler(msg, sender, resolve); });
}

function sentBlurDecision(id: string): BlurDecisionMessage | undefined {
  const match = tabMessages.find(({ msg }) => {
    const m = msg as BlurDecisionMessage;
    return m.type === "BLUR_DECISION" && m.payload.id === id;
  });
  return match?.msg as BlurDecisionMessage | undefined;
}

describe("SW fail-closed: no BLUR_DECISION when offscreen returns no usable result", () => {
  it("no BLUR_DECISION when offscreen returns neither predictions nor verdict (decode error path)", async () => {
    // Simulate offscreen returning an error result: no predictions, no verdict, no cloudError.
    // This is what offscreen.ts emits on fetch failure, image decode failure, or classify() throw.
    nextOffscreenResponse = { decodeMs: 5, inferenceMs: 0, queueWaitMs: 0 };

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fc-decode-err", url: "https://example.com/broken.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    expect(sentBlurDecision("fc-decode-err")).toBeUndefined();
  });

  it("no BLUR_DECISION when offscreen returns empty predictions array (queue drop path)", async () => {
    // Queue full returns no predictions (undefined, not empty array).
    // Confirm the SW path also handles undefined predictions correctly.
    nextOffscreenResponse = { predictions: undefined, decodeMs: 5, inferenceMs: 0, queueWaitMs: 0 };

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fc-queue-drop", url: "https://example.com/qdrop.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    expect(sentBlurDecision("fc-queue-drop")).toBeUndefined();
  });

  it("BLUR_DECISION IS sent when offscreen returns valid predictions (safe path — element revealed)", async () => {
    const safePreds: Prediction[] = [
      { className: "Neutral", probability: 0.95 },
      { className: "Drawing", probability: 0.02 },
      { className: "Sexy",    probability: 0.01 },
      { className: "Porn",    probability: 0.01 },
      { className: "Hentai",  probability: 0.01 },
    ];
    nextOffscreenResponse = { predictions: safePreds, inferenceMs: 7, queueWaitMs: 0, decodeMs: 3 };

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fc-safe", url: "https://example.com/safe.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    const decision = sentBlurDecision("fc-safe");
    expect(decision).toBeDefined();
    expect(decision!.payload.verdict.shouldBlock).toBe(false);
    expect(decision!.payload.verdict.category).toBe("safe");
  });

  it("BLUR_DECISION IS sent for explicit predictions (element stays blurred via overlay)", async () => {
    const explicitPreds: Prediction[] = [
      { className: "Porn",    probability: 0.92 },
      { className: "Hentai",  probability: 0.03 },
      { className: "Sexy",    probability: 0.02 },
      { className: "Neutral", probability: 0.02 },
      { className: "Drawing", probability: 0.01 },
    ];
    nextOffscreenResponse = { predictions: explicitPreds, inferenceMs: 9, queueWaitMs: 0, decodeMs: 4 };

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fc-explicit", url: "https://example.com/explicit.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    const decision = sentBlurDecision("fc-explicit");
    expect(decision).toBeDefined();
    expect(decision!.payload.verdict.shouldBlock).toBe(true);
    expect(decision!.payload.verdict.category).toBe("explicit");
  });

  it("no BLUR_DECISION when the extension is disabled (element keeps pre-blur)", async () => {
    storedState.enabled = false;
    nextOffscreenResponse = {
      predictions: [{ className: "Neutral", probability: 1 }] as Prediction[],
      inferenceMs: 5, queueWaitMs: 0, decodeMs: 2,
    };

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fc-disabled", url: "https://example.com/img.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    expect(sentBlurDecision("fc-disabled")).toBeUndefined();
    storedState.enabled = true; // restore for subsequent tests
  });
});
