// src/test/allowlist.test.ts
//
// Tests the SW-side allowlist handlers: ADD_ALLOWLIST_DOMAIN, REMOVE_ALLOWLIST_DOMAIN,
// and the ALLOWLIST_UPDATED broadcast to all open tabs.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AddAllowlistDomainMessage,
  AllowlistUpdatedMessage,
  BlurGuardState,
  RemoveAllowlistDomainMessage,
} from "../types/messages";

// ── Chrome stub ───────────────────────────────────────────────────────────────

const capturedHandlers: Array<
  (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void
> = [];

const tabMessages: Array<{ tabId: number; msg: unknown }> = [];
const runtimeMessages: Array<unknown> = [];

// Mutable stored state — gets updated by storage.local.set so getState() sees the change.
let storedState: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  apiBackend: "tfjs",
  feed: [],
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  allowlist: [],
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
      if ((msg as { type: string }).type === "OFFSCREEN_PING") {
        return Promise.resolve({ type: "OFFSCREEN_READY" });
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
    // Two open tabs so broadcastToAllTabs has concrete targets.
    query: vi.fn().mockResolvedValue([{ id: 10 }, { id: 11 }]),
    sendMessage: vi.fn().mockImplementation((tabId: number, msg: unknown) => {
      tabMessages.push({ tabId, msg });
      return Promise.resolve();
    }),
  },
  storage: {
    local: {
      get: vi.fn().mockImplementation((key: string) =>
        Promise.resolve({ [key]: key === "blurguard" ? storedState : undefined })
      ),
      set: vi.fn().mockImplementation((data: Record<string, unknown>) => {
        if ("blurguard" in data) storedState = data.blurguard as BlurGuardState;
        return Promise.resolve();
      }),
    },
  },
});

beforeAll(async () => {
  await import("../background");
});

const baseAllowlist: string[] = [];

beforeEach(() => {
  storedState = {
    enabled: true,
    pausedUntil: 0,
    sensitivity: "balanced",
    apiBackend: "tfjs",
    feed: [],
    stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
    cloudWarning: null,
    allowlist: [...baseAllowlist],
  };
  tabMessages.length = 0;
  runtimeMessages.length = 0;
  vi.mocked(chrome.tabs.sendMessage).mockClear();
  vi.mocked(chrome.storage.local.set).mockClear();
});

function dispatchToSW(msg: unknown): Promise<unknown> {
  const handler = capturedHandlers[0];
  if (!handler) throw new Error("No SW handler captured");
  return new Promise((resolve) => {
    handler(msg, {}, resolve);
  });
}

function allowlistUpdatedPayloads(): string[][] {
  return tabMessages
    .filter(({ msg }) => (msg as AllowlistUpdatedMessage).type === "ALLOWLIST_UPDATED")
    .map(({ msg }) => (msg as AllowlistUpdatedMessage).payload);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SW allowlist handlers", () => {
  it("ADD_ALLOWLIST_DOMAIN persists the domain to state", async () => {
    await dispatchToSW({
      type: "ADD_ALLOWLIST_DOMAIN",
      payload: "evil.example.com",
    } satisfies AddAllowlistDomainMessage);

    expect(storedState.allowlist).toContain("evil.example.com");
  });

  it("ADD_ALLOWLIST_DOMAIN broadcasts ALLOWLIST_UPDATED to every open tab", async () => {
    await dispatchToSW({
      type: "ADD_ALLOWLIST_DOMAIN",
      payload: "ads.example.com",
    } satisfies AddAllowlistDomainMessage);

    const payloads = allowlistUpdatedPayloads();
    // One broadcast per open tab (two tabs configured)
    expect(payloads.length).toBeGreaterThanOrEqual(2);
    expect(payloads[0]).toContain("ads.example.com");
  });

  it("ADD_ALLOWLIST_DOMAIN is idempotent — duplicate has no effect", async () => {
    storedState.allowlist = ["dupe.example.com"];

    await dispatchToSW({
      type: "ADD_ALLOWLIST_DOMAIN",
      payload: "dupe.example.com",
    } satisfies AddAllowlistDomainMessage);

    // No storage write should have happened (domain was already present)
    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();
    expect(storedState.allowlist).toEqual(["dupe.example.com"]);
  });

  it("REMOVE_ALLOWLIST_DOMAIN removes the domain from state", async () => {
    storedState.allowlist = ["a.example.com", "b.example.com"];

    await dispatchToSW({
      type: "REMOVE_ALLOWLIST_DOMAIN",
      payload: "a.example.com",
    } satisfies RemoveAllowlistDomainMessage);

    expect(storedState.allowlist).not.toContain("a.example.com");
    expect(storedState.allowlist).toContain("b.example.com");
  });

  it("REMOVE_ALLOWLIST_DOMAIN broadcasts ALLOWLIST_UPDATED without the removed domain", async () => {
    storedState.allowlist = ["x.example.com", "y.example.com"];

    await dispatchToSW({
      type: "REMOVE_ALLOWLIST_DOMAIN",
      payload: "x.example.com",
    } satisfies RemoveAllowlistDomainMessage);

    const payloads = allowlistUpdatedPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(1);
    expect(payloads[0]).not.toContain("x.example.com");
    expect(payloads[0]).toContain("y.example.com");
  });
});
