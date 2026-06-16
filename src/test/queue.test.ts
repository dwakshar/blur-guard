// src/test/queue.test.ts
//
// Covers the SW classify queue: priority ordering, serialisation, CANCEL, PRIORITIZE.
// Uses a controlled offscreen resolver so items can be hung mid-flight.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BlurDecisionMessage,
  ClassifyCancelMessage,
  ClassifyPrioritizeMessage,
  ClassifyRequestMessage,
  Prediction,
} from "../types/messages";
import { resetMemoryStore } from "../lib/verdict-cache";

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

// Yields enough microtasks + one macrotask for async processClassify chains to settle.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 10));
}

// ── Chrome stub ───────────────────────────────────────────────────────────────

const capturedHandlers: Array<
  (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void
> = [];

const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
const runtimeMessages: Array<unknown> = [];

// Per-ID resolvers so each OFFSCREEN_CLASSIFY hangs until explicitly resolved.
const offscreenResolvers = new Map<string, (val: unknown) => void>();

const storedState = {
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
      // Report the offscreen doc as already existing so ensureOffscreen() is a no-op
      // and offscreenReady won't be reset between items.
      Promise.resolve([{ contextType: "OFFSCREEN_DOCUMENT" }])
    ),
    sendMessage: vi.fn().mockImplementation((msg: unknown) => {
      runtimeMessages.push(msg);
      const m = msg as { type: string; payload?: { id: string } };
      if (m.type === "OFFSCREEN_PING") {
        return Promise.resolve({ type: "OFFSCREEN_READY" });
      }
      if (m.type === "OFFSCREEN_CLASSIFY") {
        return new Promise((resolve) => {
          offscreenResolvers.set(m.payload!.id, resolve);
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

function resolveOffscreen(id: string, predictions = safePredictions()): void {
  const resolve = offscreenResolvers.get(id);
  if (!resolve) throw new Error(`No pending resolver for id=${id}`);
  offscreenResolvers.delete(id);
  resolve({ id, predictions, inferenceMs: 1, queueWaitMs: 0, decodeMs: 0 });
}

function sentBlurDecision(id: string): BlurDecisionMessage | undefined {
  const match = tabMessages.find(({ msg }) => {
    const m = msg as BlurDecisionMessage;
    return m.type === "BLUR_DECISION" && m.payload.id === id;
  });
  return match?.msg as BlurDecisionMessage | undefined;
}

beforeEach(() => {
  tabMessages.length = 0;
  runtimeMessages.length = 0;
  resetMemoryStore();
  vi.mocked(chrome.tabs.sendMessage).mockClear();
  vi.mocked(chrome.runtime.sendMessage).mockClear();
});

afterEach(async () => {
  // Drain any resolvers left over from a failed/incomplete test so the SW
  // module's dispatchBusy flag returns to false before the next test runs.
  for (const [id, resolve] of offscreenResolvers) {
    resolve({ id, predictions: safePredictions(), inferenceMs: 0, queueWaitMs: 0, decodeMs: 0 });
  }
  offscreenResolvers.clear();
  await flushAsync();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("priority queue", () => {
  it("serialises: second classify waits until first completes", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ser-A", url: "https://a.com/1.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "ser-B", url: "https://b.com/2.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    // Only A should be at the offscreen boundary; B must wait.
    expect(offscreenResolvers.has("ser-A")).toBe(true);
    expect(offscreenResolvers.has("ser-B")).toBe(false);

    resolveOffscreen("ser-A");
    await flushAsync();

    // Now B is running.
    expect(offscreenResolvers.has("ser-B")).toBe(true);
    resolveOffscreen("ser-B");
    await flushAsync();
  });

  it("high-priority item jumps ahead of queued low-priority items", async () => {
    // A (low): starts immediately
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "low-A", url: "https://a.com/1.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    // B (low) and C (high) enqueued while A is running
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "low-B", url: "https://b.com/2.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "high-C", url: "https://c.com/3.jpg", kind: "image", priority: "high" },
    } satisfies ClassifyRequestMessage);

    // Resolve A → drain should pick high-C (front of queue), not low-B (tail)
    resolveOffscreen("low-A");
    await flushAsync();

    expect(offscreenResolvers.has("high-C")).toBe(true);
    expect(offscreenResolvers.has("low-B")).toBe(false);

    resolveOffscreen("high-C");
    await flushAsync();

    expect(offscreenResolvers.has("low-B")).toBe(true);
    resolveOffscreen("low-B");
    await flushAsync();

    // Verify OFFSCREEN_CLASSIFY order: A → C → B
    const ids = runtimeMessages
      .filter((m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY")
      .map((m) => (m as { payload: { id: string } }).payload.id);
    expect(ids).toEqual(["low-A", "high-C", "low-B"]);
  });

  it("two low-priority items process in FIFO order", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fifo-1", url: "https://a.com/1.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "fifo-2", url: "https://b.com/2.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);

    resolveOffscreen("fifo-1");
    await flushAsync();

    expect(offscreenResolvers.has("fifo-2")).toBe(true);
    resolveOffscreen("fifo-2");
    await flushAsync();

    const ids = runtimeMessages
      .filter((m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY")
      .map((m) => (m as { payload: { id: string } }).payload.id);
    expect(ids).toEqual(["fifo-1", "fifo-2"]);
  });

  it("CLASSIFY_CANCEL removes a queued item so it is never sent to offscreen", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "can-A", url: "https://a.com/1.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "can-B", url: "https://b.com/2.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);

    // Cancel B before A finishes
    await dispatchToSW({
      type: "CLASSIFY_CANCEL",
      payload: { id: "can-B" },
    } satisfies ClassifyCancelMessage);

    resolveOffscreen("can-A");
    await flushAsync();

    const ids = runtimeMessages
      .filter((m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY")
      .map((m) => (m as { payload: { id: string } }).payload.id);
    expect(ids).not.toContain("can-B");
  });

  it("CLASSIFY_PRIORITIZE moves a tail item to the front of the queue", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "pri-A", url: "https://a.com/1.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "pri-B", url: "https://b.com/2.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);

    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "pri-C", url: "https://c.com/3.jpg", kind: "image", priority: "low" },
    } satisfies ClassifyRequestMessage);

    // Promote C (tail) ahead of B
    await dispatchToSW({
      type: "CLASSIFY_PRIORITIZE",
      payload: { id: "pri-C" },
    } satisfies ClassifyPrioritizeMessage);

    resolveOffscreen("pri-A");
    await flushAsync();

    // C was promoted → should be next, not B
    expect(offscreenResolvers.has("pri-C")).toBe(true);
    expect(offscreenResolvers.has("pri-B")).toBe(false);

    resolveOffscreen("pri-C");
    await flushAsync();

    resolveOffscreen("pri-B");
    await flushAsync();

    const ids = runtimeMessages
      .filter((m) => (m as { type: string }).type === "OFFSCREEN_CLASSIFY")
      .map((m) => (m as { payload: { id: string } }).payload.id);
    expect(ids).toEqual(["pri-A", "pri-C", "pri-B"]);
  });

  it("explicit video verdict → BLUR_DECISION with shouldBlock true", async () => {
    await dispatchToSW({
      type: "CLASSIFY_REQUEST",
      payload: { id: "vid-x", url: "https://cdn.example.com/clip.mp4", kind: "video", priority: "high" },
    } satisfies ClassifyRequestMessage);
    await flushAsync();

    resolveOffscreen("vid-x", explicitPredictions());
    await flushAsync();

    const decision = sentBlurDecision("vid-x");
    expect(decision?.payload.verdict.shouldBlock).toBe(true);
    expect(decision?.payload.verdict.category).toBe("explicit");
  });
});
