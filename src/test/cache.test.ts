// src/test/cache.test.ts
//
// Part A — verdict-cache unit tests: miss, hit, LRU eviction, deriveVerdict,
//           sensitivity re-derivation without re-fetching.
// Part B — SW integration: cache hit bypasses OFFSCREEN_CLASSIFY.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BlurDecisionMessage,
  ClassifyRequestMessage,
  Prediction,
} from "../types/messages";
import {
  cacheGet,
  cacheSet,
  deriveVerdict,
  resetMemoryStore,
} from "../lib/verdict-cache";

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Shared mock storage (persists across get/set within a test) ───────────────

const mockStorage: Record<string, unknown> = {};

const capturedHandlers: Array<
  (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void
> = [];
const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
const runtimeMessages: Array<unknown> = [];

let nextOffscreenPredictions: Prediction[] = safePredictions();

const baseState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced" as const,
  apiBackend: "tfjs" as const,
  feed: [],
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
      if (m.type === "OFFSCREEN_PING") return Promise.resolve({ type: "OFFSCREEN_READY" });
      if (m.type === "OFFSCREEN_CLASSIFY") {
        return Promise.resolve({
          id: m.payload!.id,
          predictions: nextOffscreenPredictions,
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
    sendMessage: vi.fn().mockImplementation((tabId: number, msg: unknown) => {
      tabMessages.push({ tabId, msg });
      return Promise.resolve();
    }),
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation((key: string) =>
        Promise.resolve({ [key]: mockStorage[key] })
      ),
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        Object.assign(mockStorage, data);
        return Promise.resolve();
      }),
    },
  },
});

beforeAll(async () => {
  mockStorage["blurguard"] = { ...baseState };
  await import("../background");
});

beforeEach(() => {
  // Clear persisted vcache between tests; force loadStore() to re-read.
  delete mockStorage["blurguard_vcache"];
  mockStorage["blurguard"] = { ...baseState };
  resetMemoryStore();

  tabMessages.length = 0;
  runtimeMessages.length = 0;
  nextOffscreenPredictions = safePredictions();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
});

function dispatchToSW(
  msg: unknown,
  sender: { tab?: { id: number } } = { tab: { id: 42 } },
): Promise<unknown> {
  const handler = capturedHandlers[0];
  if (!handler) throw new Error("No SW handler captured");
  return new Promise((resolve) => {
    handler(msg, sender, resolve);
  });
}

function sentBlurDecision(id: string): BlurDecisionMessage | undefined {
  return tabMessages.find(({ msg }) => {
    const m = msg as BlurDecisionMessage;
    return m.type === "BLUR_DECISION" && m.payload.id === id;
  })?.msg as BlurDecisionMessage | undefined;
}

// ── Part A: verdict-cache unit tests ─────────────────────────────────────────

describe("verdict-cache — unit", () => {
  it("returns undefined for an uncached URL", async () => {
    const entry = await cacheGet("https://example.com/miss.jpg");
    expect(entry).toBeUndefined();
  });

  it("returns the stored entry after cacheSet", async () => {
    await cacheSet("https://example.com/hit.jpg", {
      backend: "tfjs",
      predictions: safePredictions(),
      cachedAt: Date.now(),
    });

    const entry = await cacheGet("https://example.com/hit.jpg");
    expect(entry).toBeDefined();
    expect(entry!.backend).toBe("tfjs");
    expect(entry!.predictions).toBeDefined();
  });

  it("survives a memStore reset (re-loads from mock storage)", async () => {
    await cacheSet("https://example.com/persist.jpg", {
      backend: "tfjs",
      predictions: safePredictions(),
      cachedAt: Date.now(),
    });

    resetMemoryStore();

    const entry = await cacheGet("https://example.com/persist.jpg");
    expect(entry).toBeDefined();
  });

  it("LRU eviction: oldest entry is dropped when cap (500) is reached", async () => {
    const firstUrl = "https://example.com/0.jpg";

    for (let i = 0; i < 500; i++) {
      await cacheSet(`https://example.com/${i}.jpg`, {
        backend: "tfjs",
        predictions: safePredictions(),
        cachedAt: Date.now(),
      });
    }

    // First entry should still exist before we exceed the cap.
    expect(await cacheGet(firstUrl)).toBeDefined();

    // Insert the 501st entry → firstUrl should be evicted.
    await cacheSet("https://example.com/new.jpg", {
      backend: "tfjs",
      predictions: safePredictions(),
      cachedAt: Date.now(),
    });

    expect(await cacheGet(firstUrl)).toBeUndefined();
    expect(await cacheGet("https://example.com/new.jpg")).toBeDefined();
    // Entry 1 should survive (was not the oldest)
    expect(await cacheGet("https://example.com/1.jpg")).toBeDefined();
  });

  it("deriveVerdict produces correct category from cached tfjs predictions", async () => {
    await cacheSet("https://example.com/x.jpg", {
      backend: "tfjs",
      predictions: explicitPredictions(),
      cachedAt: Date.now(),
    });
    const entry = (await cacheGet("https://example.com/x.jpg"))!;

    const v = deriveVerdict(entry, "balanced");
    expect(v.category).toBe("explicit");
    expect(v.shouldBlock).toBe(true);
  });

  it("re-derives verdict under different sensitivity without a new API call", async () => {
    // sum = 0.40: strict (0.35) → explicit, balanced (0.45) → safe
    const borderPreds: Prediction[] = [
      { className: "Porn",    probability: 0.38 },
      { className: "Hentai",  probability: 0.02 },
      { className: "Sexy",    probability: 0.02 },
      { className: "Neutral", probability: 0.54 },
      { className: "Drawing", probability: 0.04 },
    ];
    await cacheSet("https://example.com/border.jpg", {
      backend: "tfjs",
      predictions: borderPreds,
      cachedAt: Date.now(),
    });
    const entry = (await cacheGet("https://example.com/border.jpg"))!;

    expect(deriveVerdict(entry, "strict").shouldBlock).toBe(true);
    expect(deriveVerdict(entry, "balanced").shouldBlock).toBe(false);
  });
});

// ── Part B: SW integration ────────────────────────────────────────────────────

describe("verdict-cache — SW integration", () => {
  it("cache hit → BLUR_DECISION sent without OFFSCREEN_CLASSIFY", async () => {
    await cacheSet("https://cdn.example.com/img.jpg", {
      backend: "tfjs",
      predictions: safePredictions(),
      cachedAt: Date.now(),
    });

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: {
        id: "cache-hit",
        url: "https://cdn.example.com/img.jpg",
        kind: "image",
        priority: "high",
      },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("cache-hit");
    expect(decision).toBeDefined();

    const classifyMsgs = runtimeMessages.filter(
      (m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY"
    );
    expect(classifyMsgs).toHaveLength(0);
  });

  it("cache hit with explicit predictions → BLUR_DECISION shouldBlock true", async () => {
    await cacheSet("https://cdn.example.com/nsfw.jpg", {
      backend: "tfjs",
      predictions: explicitPredictions(),
      cachedAt: Date.now(),
    });

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: {
        id: "cache-nsfw",
        url: "https://cdn.example.com/nsfw.jpg",
        kind: "image",
        priority: "high",
      },
    } satisfies ClassifyRequestMessage);

    const decision = sentBlurDecision("cache-nsfw");
    expect(decision?.payload.verdict.shouldBlock).toBe(true);
    expect(decision?.payload.verdict.category).toBe("explicit");
  });
});
