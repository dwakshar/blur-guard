// BlurGuard background service worker for MV3.
// Owns extension state, offscreen document lifecycle, and the classify round-trip.

import type {
  ApiBackend,
  BlurGuardMessage,
  BlurGuardState,
  ClassifyResultMessage,
  DetectionEvent,
  DetectionReportPayload,
  Sensitivity,
  SightengineConfig,
  Verdict,
} from "./types/messages";
import { assertNever } from "./types/messages";
import { verdictFromPredictions } from "./lib/classifier";
import { cacheGet, cacheSet, deriveVerdict } from "./lib/verdict-cache";
import { CLOUD_BACKEND_ENABLED } from "./lib/featureFlags";

const DEFAULT_STATE: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  apiBackend: "tfjs",   // on-device by default; user must opt in to "sightengine"
  feed: [],
  stats: {
    images: 0,
    videos: 0,
    blocked: 0,
    cloudErrors: 0,
  },
  cloudWarning: null,
  allowlist: [],
};

// ── Cloud failure policy: FAIL-OPEN-BUT-LOUD ──────────────────────────────────
//
// When a Sightengine API call fails (HTTP error, timeout, bad credentials,
// rate limit), the image is NOT blurred.  Rationale: a browsing tool that blurs
// every image on transient network failures is unusable; availability takes priority.
//
// Trade-off accepted: a cloud failure means NSFW content may go unblocked.
//
// Mitigation — failures are ALWAYS visible, three ways:
//   1. Per-event console log:  [BlurGuard] cloud check FAILED id=… reason=…
//   2. Feed entry:            "Cloud check failed — not blocked" in the popup feed
//   3. Popup warning banner:  cloudWarning set in BlurGuardState after N consecutive
//                             failures so the user sees it on next popup open
//
// To switch to fail-CLOSED (blur on uncertainty), change shouldBlock to true in
// buildCloudErrorState() below.  The rest of the pipeline handles it correctly.

const CLOUD_FAILURE_WARNING_THRESHOLD = 3;

// In-memory — resets when the SW is reloaded.  cloudWarning in persisted state
// ensures the user sees the warning even after SW sleep/restart.
let cloudConsecutiveFailures = 0;

// Separate storage key for Sightengine credentials.
// Never merged into BlurGuardState so credentials are never broadcast in STATE_UPDATED.
const SIGHTENGINE_STORAGE_KEY = "blurguard_sightengine" as const;

async function getApiConfig(): Promise<SightengineConfig | null> {
  const data = await chrome.storage.local.get(SIGHTENGINE_STORAGE_KEY);
  const cfg = data[SIGHTENGINE_STORAGE_KEY] as Partial<SightengineConfig> | undefined;
  if (!cfg?.apiUser || !cfg?.apiSecret) return null;
  return { apiUser: cfg.apiUser, apiSecret: cfg.apiSecret };
}

// ── Offscreen document lifecycle ──────────────────────────────────────────────
// Only one offscreen doc may exist per extension at a time (Chrome limit).
// offscreenCreating serializes concurrent createDocument() calls.
// offscreenReady tracks whether the current doc has completed model init and
// responded OFFSCREEN_READY to a PING — reset whenever a new doc is created.

let offscreenCreating: Promise<void> | null = null;
let offscreenReady = false;

// ── SW-side priority classify queue ──────────────────────────────────────────
//
// Holds pending classify requests before dispatch to the offscreen doc.
// High-priority (in-viewport) items are inserted at the front so they run next.
// Low-priority (off-screen) items are appended. One dispatch is active at a time
// (dispatchBusy flag), preserving the one-inference-at-a-time GPU serialization
// that exists in the offscreen queueTail chain.

interface QueueItem {
  id: string;
  url: string;
  kind: "image" | "video";
  priority: "high" | "low";
  backend: "tfjs" | "sightengine";
  pageUrl?: string;
  sensitivity: Sensitivity;
  sightengineConfig?: SightengineConfig;
  tabId: number | undefined;
  tDetected: number;
}

const MAX_SW_QUEUE = 100;
const classifyQueue: QueueItem[] = [];
let dispatchBusy = false;

// ── Idle offscreen teardown ───────────────────────────────────────────────────
// Chrome MV3 tears down the offscreen doc when the SW sleeps (~30 s inactivity).
// We also close it proactively after OFFSCREEN_IDLE_MS of queue inactivity so
// WebGL + model memory is released while the SW is still alive between bursts.
// offscreenReady is reset so the next classify creates a fresh doc and re-pings.

const OFFSCREEN_IDLE_MS = 30_000;
let offscreenIdleTimer: ReturnType<typeof setTimeout> | null = null;

function cancelOffscreenTeardown(): void {
  if (offscreenIdleTimer !== null) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
  }
}

function scheduleOffscreenTeardown(): void {
  cancelOffscreenTeardown();
  offscreenIdleTimer = setTimeout(async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (contexts.length === 0) return;
    try {
      await chrome.offscreen.closeDocument();
      offscreenReady = false;
      console.log("[BlurGuard SW] offscreen closed after idle");
    } catch (err) {
      console.warn("[BlurGuard SW] offscreen close failed:", err);
    }
  }, OFFSCREEN_IDLE_MS);
}

function enqueueClassify(item: QueueItem): void {
  cancelOffscreenTeardown();
  if (item.priority === "high") {
    classifyQueue.unshift(item);
    // Hard cap: trim the tail (all low-priority) if needed
    if (classifyQueue.length > MAX_SW_QUEUE) classifyQueue.length = MAX_SW_QUEUE;
  } else {
    if (classifyQueue.length >= MAX_SW_QUEUE) {
      console.warn(`[BlurGuard SW] queue full (${MAX_SW_QUEUE}), dropping low-priority: ${item.url}`);
      return;
    }
    classifyQueue.push(item);
  }
  drainQueue();
}

function drainQueue(): void {
  if (dispatchBusy || classifyQueue.length === 0) {
    if (!dispatchBusy && classifyQueue.length === 0) scheduleOffscreenTeardown();
    return;
  }
  dispatchBusy = true;
  const item = classifyQueue.shift()!;
  void processClassify(item).finally(() => {
    dispatchBusy = false;
    drainQueue();
  });
}

async function processClassify(item: QueueItem): Promise<void> {
  const { id, url, kind, backend, sensitivity, sightengineConfig, pageUrl, tabId, tDetected } = item;

  // Re-check: state may have changed while item sat in queue.
  const state = await getState();
  if (!state.enabled || state.pausedUntil > Date.now()) return;

  await ensureOffscreen();
  await waitForOffscreenReady();

  let raw: ClassifyResultMessage["payload"] | undefined;
  try {
    raw = (await chrome.runtime.sendMessage({
      type: "OFFSCREEN_CLASSIFY",
      payload: { id, url, kind, backend, sensitivity, sightengineConfig, pageUrl },
    })) as ClassifyResultMessage["payload"];
  } catch (err) {
    console.error("[BlurGuard SW] offscreen classify error:", err);
    return;
  }

  // ── Cloud error path ──────────────────────────────────────────────────────
  if (raw?.cloudError) {
    const latencyMs = Math.round(performance.now() - tDetected);
    console.error(
      `[BlurGuard] cloud check FAILED id=${id} reason=${raw.cloudError} latencyMs=${latencyMs}`
    );
    cloudConsecutiveFailures++;
    let nextCloudWarning = state.cloudWarning;
    if (cloudConsecutiveFailures >= CLOUD_FAILURE_WARNING_THRESHOLD && !state.cloudWarning) {
      nextCloudWarning =
        `${cloudConsecutiveFailures} consecutive cloud checks failed. ` +
        `Last error: ${raw.cloudError.slice(0, 120)}`;
      console.warn(`[BlurGuard] cloudWarning set after ${cloudConsecutiveFailures} consecutive failures`);
    }
    const nextState = buildCloudErrorState(state, id, url, kind, raw.cloudError, latencyMs, backend, nextCloudWarning);
    await chrome.storage.local.set({ blurguard: nextState });
    await notifyPopup(nextState);
    if (tabId !== undefined) {
      chrome.tabs.sendMessage(tabId, {
        type: "BLUR_DECISION",
        payload: {
          id,
          verdict: { category: "safe", confidence: 0, shouldBlock: false, reasons: ["cloud check failed"] },
          decodeMs: raw.decodeMs,
          inferenceMs: 0,
          queueWaitMs: 0,
          latencyMs,
        },
      }).catch(() => {});
    }
    return;
  }

  // ── Normal verdict path ───────────────────────────────────────────────────
  let verdict: Verdict;
  if (raw?.verdict) {
    verdict = raw.verdict;
    cloudConsecutiveFailures = 0;
    if (state.cloudWarning !== null) {
      await updateState({ cloudWarning: null });
      await notifyPopup(await getState());
    }
  } else if (raw?.predictions?.length) {
    verdict = verdictFromPredictions(raw.predictions, sensitivity);
  } else {
    return;
  }

  // ── Cache store ───────────────────────────────────────────────────────────
  // Store raw scores so future hits can re-derive the verdict under any sensitivity.
  // Cloud errors are not cached — only store on confirmed inference success.
  if (raw?.predictions?.length) {
    void cacheSet(url, { backend: "tfjs", predictions: raw.predictions, cachedAt: Date.now() });
  } else if (raw?.nudity) {
    void cacheSet(url, { backend: "sightengine", nudity: raw.nudity, cachedAt: Date.now() });
  }

  const latencyMs = Math.round(performance.now() - tDetected);

  if (raw?.predictions?.length) {
    const s = Object.fromEntries(raw.predictions.map((p) => [p.className, p.probability.toFixed(3)]));
    console.log(
      `[BlurGuard tfjs] id=${id} verdict=${verdict.category} block=${verdict.shouldBlock}` +
      ` scores={Porn:${s.Porn},Hentai:${s.Hentai},Sexy:${s.Sexy},Neutral:${s.Neutral},Drawing:${s.Drawing}}` +
      ` infMs=${raw.inferenceMs} queueMs=${raw.queueWaitMs} decodeMs=${raw.decodeMs} latencyMs=${latencyMs}`
    );
  } else {
    console.log(
      `[BlurGuard sightengine] id=${id} verdict=${verdict.category} block=${verdict.shouldBlock}` +
      ` confidence=${verdict.confidence.toFixed(3)}` +
      ` infMs=${raw?.inferenceMs ?? 0} decodeMs=${raw?.decodeMs ?? 0} latencyMs=${latencyMs}`
    );
  }

  if (tabId !== undefined) {
    chrome.tabs
      .sendMessage(tabId, {
        type: "BLUR_DECISION",
        payload: {
          id,
          verdict,
          decodeMs: raw.decodeMs,
          inferenceMs: raw.inferenceMs,
          queueWaitMs: raw.queueWaitMs,
          latencyMs,
        },
      })
      .catch(() => {});
  }

  if (verdict.shouldBlock) {
    const nextState = buildNextState(
      state, id, url, kind, verdict,
      raw.inferenceMs, raw.queueWaitMs, raw.decodeMs, latencyMs, backend,
    );
    await chrome.storage.local.set({ blurguard: nextState });
    await notifyPopup(nextState);
  }
}

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (existing.length > 0) return;

  // New doc being created — must re-confirm readiness after JS loads.
  offscreenReady = false;

  if (offscreenCreating) {
    await offscreenCreating;
    return;
  }

  // JS is single-threaded: after `await getContexts()` resolves, this block runs
  // synchronously until `await offscreenCreating` below. Any concurrent caller
  // that reaches here will see `offscreenCreating` already set and take the
  // `await offscreenCreating` path above. The "Only a single offscreen document"
  // error therefore cannot fire in normal operation; no defensive catch needed.
  offscreenCreating = chrome.offscreen.createDocument({
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
  });

  try {
    await offscreenCreating;
  } finally {
    offscreenCreating = null;
  }
}

// Poll OFFSCREEN_PING until the offscreen doc responds OFFSCREEN_READY.
// The gap between createDocument() resolving and the offscreen JS setting up its
// message listener is real and causes "Receiving end does not exist" if we
// send OFFSCREEN_CLASSIFY immediately. Model load + warmup can take 5–15 s
// cold, so the timeout is generous.
async function waitForOffscreenReady(): Promise<void> {
  if (offscreenReady) return;

  const INTERVAL_MS = 300;
  const TIMEOUT_MS = 30_000;
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const res = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
      if ((res as { type?: string })?.type === "OFFSCREEN_READY") {
        offscreenReady = true;
        console.log("[BlurGuard SW] offscreen ready ✓");
        return;
      }
    } catch {
      // Listener not yet registered — offscreen JS still loading. Keep polling.
    }
    await new Promise<void>((r) => setTimeout(r, INTERVAL_MS));
  }

  throw new Error("[BlurGuard SW] offscreen did not become ready within 30 s");
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
        cloudWarning: null,
      };
      cloudConsecutiveFailures = 0;
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

    case "SET_API_BACKEND": {
      // Silently refuse to activate the cloud backend in v1 builds.
      if (!CLOUD_BACKEND_ENABLED && message.payload === "sightengine") {
        return { ok: true };
      }
      await updateState({ apiBackend: message.payload });
      await notifyPopup(await getState());
      return { ok: true };
    }

    case "SET_API_CONFIG": {
      // Stored under a separate key — never sent to content scripts.
      await chrome.storage.local.set({ [SIGHTENGINE_STORAGE_KEY]: message.payload });
      return { ok: true };
    }

    case "ADD_ALLOWLIST_DOMAIN": {
      const domain = message.payload.toLowerCase().trim();
      if (!domain) return { ok: true };
      const current = await getState();
      if (!current.allowlist.includes(domain)) {
        const nextAllowlist = [...current.allowlist, domain];
        await updateState({ allowlist: nextAllowlist });
        await broadcastToAllTabs({ type: "ALLOWLIST_UPDATED", payload: nextAllowlist });
        await notifyPopup(await getState());
      }
      return { ok: true };
    }

    case "REMOVE_ALLOWLIST_DOMAIN": {
      const domain = message.payload.toLowerCase().trim();
      const current = await getState();
      const nextAllowlist = current.allowlist.filter((d) => d !== domain);
      if (nextAllowlist.length !== current.allowlist.length) {
        await updateState({ allowlist: nextAllowlist });
        await broadcastToAllTabs({ type: "ALLOWLIST_UPDATED", payload: nextAllowlist });
        await notifyPopup(await getState());
      }
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
        backend: state.apiBackend,
        inferenceMs: 0,   // REPORT_DETECTION originates from content script, no offscreen timing
        queueWaitMs: 0,
        decodeMs: 0,
        latencyMs: 0,
      };

      const nextState: BlurGuardState = {
        ...state,
        feed: [event, ...state.feed].slice(0, 500),
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
    case "ALLOWLIST_UPDATED":
      return { ok: true };

    // ── Inference pipeline ────────────────────────────────────────────────────

    case "CLASSIFY_REQUEST": {
      // tDetected: moment the content script's observation reached the SW.
      // Passed through to processClassify so latencyMs spans the full round-trip.
      const tDetected = performance.now();

      const state = await getState();
      if (!state.enabled || state.pausedUntil > Date.now()) return { ok: true };

      const { id, url, kind, priority, pageUrl } = message.payload;
      const tabId = sender?.tab?.id;

      // Cache check — re-derive verdict with current sensitivity and skip the queue.
      const cached = await cacheGet(url);
      if (cached) {
        const verdict = deriveVerdict(cached, state.sensitivity);
        const latencyMs = Math.round(performance.now() - tDetected);
        console.log(
          `[BlurGuard cache] HIT id=${id} verdict=${verdict.category} block=${verdict.shouldBlock}` +
          ` url=${url.slice(0, 80)}`
        );
        if (tabId !== undefined) {
          chrome.tabs.sendMessage(tabId, {
            type: "BLUR_DECISION",
            payload: { id, verdict, decodeMs: 0, inferenceMs: 0, queueWaitMs: 0, latencyMs },
          }).catch(() => {});
        }
        if (verdict.shouldBlock) {
          const nextState = buildNextState(state, id, url, kind, verdict, 0, 0, 0, latencyMs, cached.backend);
          await chrome.storage.local.set({ blurguard: nextState });
          await notifyPopup(nextState);
        }
        return { ok: true };
      }
      console.log(`[BlurGuard cache] MISS url=${url.slice(0, 80)}`);

      // Credentials are read here (SW has storage access) and forwarded per-request.
      // They never enter BlurGuardState or any broadcast to content scripts.
      let sightengineConfig: SightengineConfig | undefined;
      if (state.apiBackend === "sightengine") {
        const cfg = await getApiConfig();
        if (!cfg) {
          console.warn("[BlurGuard SW] Sightengine selected but credentials not set — skipping");
          return { ok: true };
        }
        sightengineConfig = cfg;
      }

      enqueueClassify({
        id, url, kind, priority,
        backend: state.apiBackend,
        sensitivity: state.sensitivity,
        sightengineConfig,
        pageUrl,
        tabId,
        tDetected,
      });
      return { ok: true };
    }

    case "CLASSIFY_PRIORITIZE": {
      // Promote a pending item to the front of the queue (called when its element
      // scrolls into the viewport before classification completes).
      const { id } = message.payload;
      const idx = classifyQueue.findIndex((item) => item.id === id);
      if (idx > 0) {
        const [item] = classifyQueue.splice(idx, 1);
        item.priority = "high";
        classifyQueue.unshift(item);
      }
      return { ok: true };
    }

    case "CLASSIFY_CANCEL": {
      // Remove a pending item from the queue (called when its element is removed
      // from the DOM before classification completes).
      const { id } = message.payload;
      const idx = classifyQueue.findIndex((item) => item.id === id);
      if (idx !== -1) classifyQueue.splice(idx, 1);
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
  queueWaitMs: number,
  decodeMs: number,
  latencyMs: number,
  backend: ApiBackend,
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
    backend,
    inferenceMs,
    queueWaitMs,
    decodeMs,
    latencyMs,
  };

  return {
    ...state,
    feed: [event, ...state.feed].slice(0, 500),
    stats: {
      ...state.stats,
      images: kind === "image" ? state.stats.images + 1 : state.stats.images,
      videos: kind === "video" ? state.stats.videos + 1 : state.stats.videos,
      blocked: state.stats.blocked + 1,
    },
  };
}

// Cloud API failure — adds a feed entry (visible gap) but does NOT increment
// blocked (image was not blurred — fail-open policy).  Accepts the updated
// cloudWarning value so the caller controls when the warning is set.
function buildCloudErrorState(
  state: BlurGuardState,
  id: string,
  url: string,
  kind: "image" | "video",
  errorReason: string,
  latencyMs: number,
  backend: ApiBackend,
  cloudWarning: string | null,
): BlurGuardState {
  let domain = "unknown";
  try {
    domain = new URL(url).hostname;
  } catch {}

  const event: DetectionEvent = {
    id,
    kind,
    src: url,
    domain,
    category: "safe",    // fail-open: content is unblocked
    confidence: 0,
    reasons: [],
    timestamp: Date.now(),
    backend,
    inferenceMs: 0,
    queueWaitMs: 0,
    decodeMs: 0,
    latencyMs,
    cloudCheckFailed: true,
    cloudErrorReason: errorReason.slice(0, 200),
  };

  return {
    ...state,
    feed: [event, ...state.feed].slice(0, 500),
    stats: {
      ...state.stats,
      cloudErrors: state.stats.cloudErrors + 1,
      // images/videos/blocked are NOT incremented — no content decision was made.
    },
    cloudWarning,
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
    // Cloud backend is disabled at build time in v1 — coerce any stored preference
    // back to "tfjs" so stale storage can never re-enable cloud on upgrade.
    apiBackend: (CLOUD_BACKEND_ENABLED && stored.apiBackend === "sightengine") ? "sightengine" : "tfjs",
    // cloudWarning: explicit default handles older stored state that lacks this field.
    cloudWarning: stored.cloudWarning ?? null,
    // allowlist: explicit default handles older stored state that lacks this field.
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : [],
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
