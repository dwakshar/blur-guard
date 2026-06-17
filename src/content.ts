// src/content.ts
// BlurGuard - Content Script
// Phase 0.6: async classify via SW (CLASSIFY_REQUEST / BLUR_DECISION round-trip).
// Phase 3: block-by-default pre-blur injected at document_start; JS reveals on SAFE verdict.

import { applyContextBlur, applyOverlay, removeAllOverlays } from "./lib/blurOverlay";
import { startDetector, stopDetector } from "./lib/mediaDetector";
import { VideoFrameSampler } from "./lib/videoSampler";
import type {
  BlurDecisionMessage,
  BlurGuardMessage,
  BlurGuardState,
  Sensitivity,
} from "./types/messages";

// ─── Pre-blur constants ───────────────────────────────────────────────────────
//
// preblur.css (injected at document_start) applies filter:blur(22px) to every
// img and video that lacks .bg-cleared.  JS adds .bg-cleared to:
//   • Elements below the size thresholds (icon/sprite-sized, presumed safe UI)
//   • Elements whose verdict is SAFE (reveal)
//   • All elements when the extension is disabled or the domain is allowlisted
//
// Elements whose verdict is EXPLICIT/SUSPICIOUS keep the pre-blur and get the
// permanent overlay wrapper on top.  Elements with no verdict yet (pending,
// errored, timed-out) stay blurred — fail-closed.

const PREBLUR_CLEARED_CLASS = "bg-cleared";

// Below these thresholds the element is presumed-safe UI (icon, avatar, sprite).
// Match MIN_MEDIA_OVERLAY_EDGE / MIN_MEDIA_OVERLAY_AREA from blurOverlay.ts so
// the same elements that can't receive an overlay are also cleared immediately.
const PREBLUR_MIN_EDGE = 56;   // px
const PREBLUR_MIN_AREA = 8_000; // px²

/** Remove pre-blur from a single element (reveal). */
function clearPreblur(el: HTMLImageElement | HTMLVideoElement): void {
  el.classList.add(PREBLUR_CLEARED_CLASS);
}

/**
 * Re-apply pre-blur to a single element.
 * Used on seek (new video position is unclassified) and on re-enable/sensitivity-change.
 */
function reblurElement(el: HTMLImageElement | HTMLVideoElement): void {
  el.classList.remove(PREBLUR_CLEARED_CLASS);
}

/** Clear pre-blur on all img/video in the document (allowlist, disable). */
function clearAllPreblur(): void {
  document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")
    .forEach(clearPreblur);
}

/** Re-apply pre-blur to all img/video (re-enable, sensitivity change). */
function reapplyPreblur(): void {
  document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")
    .forEach(reblurElement);
}

/**
 * True when the element is below the icon/sprite size threshold.
 * Pre-blur is cleared immediately for these elements — no classification needed.
 */
function isTinyElement(el: HTMLImageElement | HTMLVideoElement): boolean {
  const rect = el.getBoundingClientRect();
  const w = rect.width  || (el instanceof HTMLImageElement ? el.naturalWidth  : 0);
  const h = rect.height || (el instanceof HTMLImageElement ? el.naturalHeight : 0);
  return w < PREBLUR_MIN_EDGE || h < PREBLUR_MIN_EDGE || w * h < PREBLUR_MIN_AREA;
}

// ─── Viewport priority ────────────────────────────────────────────────────────

const inViewport = new WeakSet<Element>();
let viewportObserver: IntersectionObserver | null = null;

function startViewportTracking(): void {
  if (viewportObserver) return;
  viewportObserver = new IntersectionObserver(onIntersection, {
    rootMargin: "200px 0px",
  });
}

function stopViewportTracking(): void {
  viewportObserver?.disconnect();
  viewportObserver = null;
}

function onIntersection(entries: IntersectionObserverEntry[]): void {
  for (const entry of entries) {
    const el = entry.target as HTMLImageElement | HTMLVideoElement;
    if (entry.isIntersecting) {
      inViewport.add(el);
      const id = el.getAttribute(BLURGUARD_ID_ATTR);
      if (id && pending.has(id)) {
        void sendToBackground({ type: "CLASSIFY_PRIORITIZE", payload: { id } });
      }
    } else {
      inViewport.delete(el);
      if (!document.contains(el)) {
        // Element removed from DOM — cancel pending request and stop observing.
        const id = el.getAttribute(BLURGUARD_ID_ATTR);
        if (id && pending.has(id)) {
          pending.delete(id);
          void sendToBackground({ type: "CLASSIFY_CANCEL", payload: { id } });
        }
        if (el instanceof HTMLVideoElement) videoFrameSampler.stop(el);
        viewportObserver?.unobserve(el);
      }
    }
  }
}

function isNearViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return (
    rect.bottom > -200 &&
    rect.top < window.innerHeight + 200 &&
    rect.right > -200 &&
    rect.left < window.innerWidth + 200
  );
}

const CONTENT_SCRIPT_FLAG = "__blurGuardContentScriptLoaded__";
const BLURGUARD_ID_ATTR = "data-blurguard-id";

type BlurGuardWindow = Window & {
  [CONTENT_SCRIPT_FLAG]?: boolean;
};

const blurGuardWindow = window as BlurGuardWindow;

if (!blurGuardWindow[CONTENT_SCRIPT_FLAG]) {
  blurGuardWindow[CONTENT_SCRIPT_FLAG] = true;
  void bootstrap();
}

let state: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  apiBackend: "tfjs",
  feed: [],
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  allowlist: [],
};

// In-flight CLASSIFY_REQUEST records: id → { element, performance.now() at send time }
// TODO(Phase 1): add a cleanup sweep for entries older than ~30 s in case SW never replies.
const pending = new Map<
  string,
  { el: HTMLImageElement | HTMLVideoElement; sentAt: number }
>();

const scanned = new WeakSet<Element>();
const retried = new WeakSet<Element>();

let idCounter = 0;

// ─── Video frame sampler ──────────────────────────────────────────────────────
// Instantiated once at module level; closures capture pending/inViewport by ref.

const videoFrameSampler = new VideoFrameSampler(
  // sendFrame: enqueue a frame classify request identically to an image request.
  (frameId, url, el, priority) => {
    const sentAt = performance.now();
    pending.set(frameId, { el, sentAt });
    viewportObserver?.observe(el);
    sendToBackground({
      type: "CLASSIFY_REQUEST",
      payload: { id: frameId, url, kind: "video", priority },
    });
  },
  (id) => pending.has(id),
  () => inViewport,
  // seekReblur: re-apply pre-blur when the user seeks to an unclassified position.
  (el) => reblurElement(el),
);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const response = await sendToBackground({ type: "GET_STATE" });
  if (response) {
    state = response as BlurGuardState;
  }

  // Register listener before allowlist check so ALLOWLIST_UPDATED can
  // restart scanning if this domain is later removed from the list.
  chrome.runtime.onMessage.addListener(handleMessage);

  if (state.allowlist?.includes(location.hostname)) {
    console.log(`[BlurGuard] ${location.hostname} is allowlisted — scanning disabled`);
    // Allowlisted domain: clear all pre-blur immediately so trusted sites are never blurry.
    clearAllPreblur();
    return;
  }

  if (state.enabled && state.pausedUntil <= Date.now()) {
    scanAndBlur();
    startScanning();
  } else {
    // Protection is off: reveal all content, don't blur anything.
    clearAllPreblur();
    stopScanning();
  }
}

// ─── Message handler ──────────────────────────────────────────────────────────

function handleMessage(message: BlurGuardMessage): void {
  switch (message.type) {
    case "BLUR_DECISION":
      applyDecision(message);
      return;

    case "PROTECTION_TOGGLED":
      void handleProtectionToggled(message.payload as boolean);
      return;

    case "SENSITIVITY_CHANGED":
      state.sensitivity = message.payload as Sensitivity;
      // Drop pending requests — decisions arriving after this would use stale thresholds.
      pending.clear();
      // Re-apply pre-blur to everything, then re-scan with new thresholds.
      reapplyPreblur();
      removeAllOverlays();
      // Reset video samplers so blurred state from old sensitivity is cleared.
      videoFrameSampler.stopAll();
      document
        .querySelectorAll<HTMLElement>("img, video")
        .forEach((el) => scanned.delete(el));
      scanAndBlur();
      return;

    case "ALLOWLIST_UPDATED":
      state.allowlist = message.payload;
      if (state.allowlist.includes(location.hostname)) {
        console.log(`[BlurGuard] ${location.hostname} allowlisted — stopping`);
        stopScanning();
        removeAllOverlays();
        // Allowlisted: reveal all content immediately.
        clearAllPreblur();
      } else if (state.enabled && state.pausedUntil <= Date.now()) {
        // Domain was removed from the allowlist — resume scanning.
        console.log(`[BlurGuard] ${location.hostname} removed from allowlist — resuming`);
        // Re-apply pre-blur and re-scan now that we're no longer trusted.
        reapplyPreblur();
        document
          .querySelectorAll<HTMLElement>("img, video")
          .forEach((el) => scanned.delete(el));
        scanAndBlur();
        startScanning();
      }
      return;
  }
}

async function handleProtectionToggled(enabled: boolean): Promise<void> {
  const latestState = await sendToBackground({ type: "GET_STATE" });
  if (latestState) {
    state = latestState as BlurGuardState;
  } else {
    state.enabled = enabled;
  }

  if (state.pausedUntil > Date.now()) {
    // Paused: reveal all content.
    clearAllPreblur();
    removeAllOverlays();
    stopScanning();
    return;
  }

  if (state.enabled) {
    // Re-enabled: re-apply pre-blur and re-scan everything.
    reapplyPreblur();
    document
      .querySelectorAll<HTMLElement>("img, video")
      .forEach((el) => scanned.delete(el));
    scanAndBlur();
    startScanning();
  } else {
    // Disabled: reveal all content.
    clearAllPreblur();
    removeAllOverlays();
    stopScanning();
  }
}

// ─── BLUR_DECISION handler ────────────────────────────────────────────────────

function applyDecision(message: BlurDecisionMessage): void {
  const { id, verdict, inferenceMs, decodeMs } = message.payload;

  const record = pending.get(id);
  if (!record) return; // already handled or stale
  pending.delete(id);

  const { el, sentAt } = record;
  viewportObserver?.unobserve(el);

  const roundTripMs = Math.round(performance.now() - sentAt);
  // inferenceMs is the honest on-device cost. decode and round-trip are secondary.
  console.debug(
    `[BlurGuard] id=${id} inference=${inferenceMs}ms decode=${decodeMs}ms round-trip=${roundTripMs}ms verdict=${verdict.category} block=${verdict.shouldBlock}`
  );

  if (!verdict.shouldBlock) {
    // SAFE verdict — clear pre-blur to reveal the element.
    clearPreblur(el);
    return;
  }

  if (state.pausedUntil > Date.now() || !state.enabled) return;

  // Stop video sampler — the video is blurred; further sampling is pointless.
  if (el instanceof HTMLVideoElement) videoFrameSampler.markBlurred(el);

  const canReveal = state.sensitivity !== "strict";

  const wrapper = applyOverlay(el, {
    clickToReveal: canReveal,
    blurRadius: "22px",
    badgeLabel: canReveal ? "Blurred by BlurGuard" : "Blocked by BlurGuard",
  });

  // The overlay's backdrop-filter provides visual blur; remove the pre-blur filter
  // from the element to prevent double-blur artefacts.
  if (wrapper) clearPreblur(el);

  const contextBlur = wrapper
    ? null
    : applyContextBlur(el, {
        clickToReveal: canReveal,
        blurRadius: "10px",
        badgeLabel: canReveal
          ? "Blurred result by BlurGuard"
          : "Blocked result by BlurGuard",
      });

  // Context blur applies CSS filter to container children; clear the pre-blur
  // on the element itself to avoid layering two blur filters.
  if (contextBlur) clearPreblur(el);

  if (!wrapper && !contextBlur) {
    // Neither overlay could be applied (element too small, wrong DOM position, etc.).
    // The pre-blur CSS from document_start remains as the fallback visual block.
    return;
  }

  sendToBackground({
    type: "REPORT_DETECTION",
    payload: {
      kind: el instanceof HTMLImageElement ? "image" : "video",
      src: resolveSource(el),
      category: verdict.category,
      confidence: verdict.confidence,
      reasons: verdict.reasons,
    },
  });
}

// ─── Scanning ─────────────────────────────────────────────────────────────────

function startScanning(): void {
  if (!document.body) return;
  startViewportTracking();
  startDetector(({ element }) => {
    void scanElement(element);
  }, document.body);
}

function stopScanning(): void {
  stopViewportTracking();
  stopDetector();
  videoFrameSampler.stopAll();
}

function scanAndBlur(): void {
  if (!state.enabled || state.pausedUntil > Date.now()) return;
  const t0 = performance.now();
  const elements = document.querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video");
  const count = elements.length;
  elements.forEach((el) => void scanElement(el));
  const t1 = performance.now();
  console.log(`BlurGuard: queued ${count} elements for classification in ${(t1 - t0).toFixed(1)}ms`);
}

async function scanElement(
  el: HTMLImageElement | HTMLVideoElement,
  allowRetry = true
): Promise<void> {
  if (scanned.has(el)) return;
  if (state.pausedUntil > Date.now() || !state.enabled) return;
  scanned.add(el);

  // Immediately clear pre-blur for icon/sprite-sized elements — presumed-safe UI.
  // Layout is known at document_idle (when this JS runs), so getBoundingClientRect
  // is reliable. We do NOT classify these elements.
  if (isTinyElement(el)) {
    clearPreblur(el);
    return;
  }

  const ready = await waitForMediaReady(el, 10_000);
  // If readiness times out or the element errored, we simply return here.
  // The pre-blur CSS remains — fail-closed.
  if (!ready) return;
  if (state.pausedUntil > Date.now() || !state.enabled) return;

  const url = resolveClassifyUrl(el);

  if (!url) {
    // No src yet (e.g. lazy-load not yet triggered) — retry once.
    // Pre-blur stays in place during the retry window.
    if (allowRetry && !retried.has(el)) {
      retried.add(el);
      scanned.delete(el);
      window.setTimeout(() => void scanElement(el, false), 2_000);
    }
    return;
  }

  // ── Video: start frame sampler ────────────────────────────────────────────
  // The sampler fires at FRAME_SAMPLE_INTERVAL_MS (default 4 s) + on play/seek.
  // Each tick captures a canvas frame and sends it through the same CLASSIFY_REQUEST
  // path as images.  If the cap (MAX_ACTIVE_VIDEO_SAMPLERS) is reached, the video
  // falls through to the single-shot path below so it still gets one classification.
  if (el instanceof HTMLVideoElement) {
    if (videoFrameSampler.start(el)) return; // sampler owns this element now
    // Fell through: cap reached — fall back to single-shot poster/src classify.
  }

  // ── Image (or video cap fallback): single CLASSIFY_REQUEST ───────────────
  const id = assignStableId(el);
  const kind: "image" | "video" = el instanceof HTMLImageElement ? "image" : "video";
  const priority: "high" | "low" = isNearViewport(el) ? "high" : "low";
  const sentAt = performance.now();

  pending.set(id, { el, sentAt });
  viewportObserver?.observe(el);

  sendToBackground({
    type: "CLASSIFY_REQUEST",
    payload: { id, url, kind, priority },
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Assign a stable per-element id (data-blurguard-id). Idempotent.
 */
function assignStableId(el: HTMLImageElement | HTMLVideoElement): string {
  let id = el.getAttribute(BLURGUARD_ID_ATTR);
  if (!id) {
    id = `bg-${Date.now()}-${++idCounter}`;
    el.setAttribute(BLURGUARD_ID_ATTR, id);
  }
  return id;
}

/**
 * Resolve the URL to submit for classification.
 *
 * For <video>: the poster image is used when available because it is a single
 * decodable JPEG/PNG the offscreen classifier can process synchronously.
 * Full frame-sampling (canvas capture every N seconds) is deferred to Phase 2.
 */
function resolveClassifyUrl(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }
  // VIDEO — Phase 2 will replace this with canvas frame extraction.
  if (el.poster) return el.poster;
  if (el.currentSrc || el.src) return el.currentSrc || el.src;
  const source = el.querySelector("source");
  return source?.src || source?.getAttribute("src") || "";
}

function resolveSource(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }
  if (el.currentSrc || el.src) return el.currentSrc || el.src;
  const source = el.querySelector("source");
  return source?.src || source?.getAttribute("src") || "";
}

function waitForMediaReady(
  el: HTMLImageElement | HTMLVideoElement,
  timeoutMs: number
): Promise<boolean> {
  if (el instanceof HTMLImageElement) {
    if (el.complete && el.naturalWidth > 0) return Promise.resolve(true);

    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => cleanup(false), timeoutMs);
      const onLoad = () => cleanup(el.naturalWidth > 0);
      const onError = () => cleanup(false);
      const cleanup = (value: boolean) => {
        window.clearTimeout(timeout);
        el.removeEventListener("load", onLoad);
        el.removeEventListener("error", onError);
        resolve(value);
      };
      el.addEventListener("load", onLoad, { once: true });
      el.addEventListener("error", onError, { once: true });
    });
  }

  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve(true);

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => cleanup(false), timeoutMs);
    const onLoaded = () =>
      cleanup(el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA);
    const onError = () => cleanup(false);
    const cleanup = (value: boolean) => {
      window.clearTimeout(timeout);
      el.removeEventListener("loadeddata", onLoaded);
      el.removeEventListener("canplay", onLoaded);
      el.removeEventListener("error", onError);
      resolve(value);
    };
    el.addEventListener("loadeddata", onLoaded, { once: true });
    el.addEventListener("canplay", onLoaded, { once: true });
    el.addEventListener("error", onError, { once: true });
  });
}

function sendToBackground(message: BlurGuardMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => null);
}
