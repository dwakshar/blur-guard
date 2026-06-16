// src/lib/verdict-cache.ts
// SW-side verdict cache: keyed by image URL, backed by chrome.storage.local.
//
// KEY: full image URL (not content hash). URL covers the dominant cases
//   (thumbnails, SPA re-renders, CDN dedup) without requiring the offscreen to
//   finish fetching bytes first. Content hash catches same-image-different-URL
//   (mirrored CDNs) but the fetch must complete before we can derive the hash,
//   so we'd always pay inference on the first occurrence — no skip possible.
//   URL hashing is sufficient for the hit-rate gains we actually care about.
//
// RAW SCORES, NOT VERDICT: we cache Prediction[] (tfjs) or SightengineNudity
//   (sightengine) rather than the derived Verdict. On a cache hit, the verdict
//   is re-derived with the current sensitivity setting. This means one entry per
//   image regardless of sensitivity tier — no invalidation logic needed when the
//   user changes the sensitivity slider.
//
// LRU EVICTION: MAX_ENTRIES cap with an order array (oldest at index 0).
//   Gets promote in memory only (no storage write per hit). Sets write storage.
//   After SW sleep/wake, the order is restored from the last persisted state.
//   Approximate LRU — entries that were only read (never re-set) evict in
//   insertion order, not access order, which is acceptable.
//
// STORAGE: chrome.storage.local → survives SW sleep/wake cycles.
//   500 entries × ~280 bytes avg ≈ 140 KB — well within the 5 MB quota.

import type { Prediction, Sensitivity, SightengineNudity, Verdict } from "../types/messages";
import { verdictFromPredictions } from "./classifier";
import { sightengineVerdictFromNudity } from "./sightengine";

const STORAGE_KEY = "blurguard_vcache";
const MAX_ENTRIES = 500;

export interface CacheEntry {
  predictions?: Prediction[];   // tfjs raw output — re-derived per sensitivity on hit
  nudity?: SightengineNudity;   // sightengine raw output — re-derived per sensitivity on hit
  backend: "tfjs" | "sightengine";
  cachedAt: number;
}

interface CacheStore {
  entries: Record<string, CacheEntry>;
  order: string[];  // LRU: oldest at index 0, newest at tail
}

// In-memory mirror — loaded once per SW lifetime, updated synchronously on every set.
// Avoids a storage read on every cache check.
let memStore: CacheStore | null = null;

async function loadStore(): Promise<CacheStore> {
  if (memStore) return memStore;
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY] as Partial<CacheStore> | undefined;
  memStore = (raw?.entries && Array.isArray(raw.order))
    ? { entries: raw.entries, order: raw.order }
    : { entries: {}, order: [] };
  return memStore;
}

async function persistStore(store: CacheStore): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: store });
}

export async function cacheGet(url: string): Promise<CacheEntry | undefined> {
  const store = await loadStore();
  const entry = store.entries[url];
  if (!entry) return undefined;

  // Promote to MRU in memory only — storage write deferred to next cacheSet.
  const idx = store.order.indexOf(url);
  if (idx > 0) {
    store.order.splice(idx, 1);
    store.order.push(url);
  }
  return entry;
}

export async function cacheSet(url: string, entry: CacheEntry): Promise<void> {
  const store = await loadStore();

  // Remove existing position in order (re-insertion at tail).
  const existing = store.order.indexOf(url);
  if (existing !== -1) store.order.splice(existing, 1);

  // Evict LRU entry when inserting a new key at cap.
  if (!(url in store.entries) && store.order.length >= MAX_ENTRIES) {
    const evicted = store.order.shift()!;
    delete store.entries[evicted];
  }

  store.entries[url] = entry;
  store.order.push(url);

  await persistStore(store);
}

export function deriveVerdict(entry: CacheEntry, sensitivity: Sensitivity): Verdict {
  if (entry.backend === "tfjs" && entry.predictions) {
    return verdictFromPredictions(entry.predictions, sensitivity);
  }
  if (entry.backend === "sightengine" && entry.nudity) {
    return sightengineVerdictFromNudity(entry.nudity, sensitivity);
  }
  return { category: "safe", confidence: 0, shouldBlock: false, reasons: [] };
}

// Exported for tests.
export function resetMemoryStore(): void {
  memStore = null;
}
