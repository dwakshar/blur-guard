// src/content.ts
// BlurGuard - Content Script
// Phase 0.6: async classify via SW (CLASSIFY_REQUEST / BLUR_DECISION round-trip).
// Local pattern classifier removed; overlay logic is unchanged.

import { applyContextBlur, applyOverlay, removeAllOverlays } from "./lib/blurOverlay";
import { startDetector, stopDetector } from "./lib/mediaDetector";
import type {
  BlurDecisionMessage,
  BlurGuardMessage,
  BlurGuardState,
  Sensitivity,
} from "./types/messages";

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
  feed: [],
  stats: { images: 0, videos: 0, blocked: 0 },
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

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  const response = await sendToBackground({ type: "GET_STATE" });
  if (response) {
    state = response as BlurGuardState;
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  if (state.enabled && state.pausedUntil <= Date.now()) {
    scanAndBlur();
    startScanning();
  } else {
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
      removeAllOverlays();
      document
        .querySelectorAll<HTMLElement>("img, video")
        .forEach((el) => scanned.delete(el));
      scanAndBlur();
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
    removeAllOverlays();
    stopScanning();
    return;
  }

  if (state.enabled) {
    document
      .querySelectorAll<HTMLElement>("img, video")
      .forEach((el) => scanned.delete(el));
    scanAndBlur();
    startScanning();
  } else {
    removeAllOverlays();
    stopScanning();
  }
}

// ─── BLUR_DECISION handler ────────────────────────────────────────────────────

function applyDecision(message: BlurDecisionMessage): void {
  const { id, verdict, ms: swMs } = message.payload;

  const record = pending.get(id);
  if (!record) return; // already handled or stale
  pending.delete(id);

  const { el, sentAt } = record;

  // Latency harness: roundTripMs = content-measured end-to-end time.
  // swMs = SW-reported inference duration (fake until Phase 1 real model runs).
  const roundTripMs = Math.round(performance.now() - sentAt);
  console.debug(
    `[BlurGuard] id=${id} round-trip=${roundTripMs}ms sw-inference=${swMs}ms verdict=${verdict.category} block=${verdict.shouldBlock}`
  );

  if (!verdict.shouldBlock) return;
  if (state.pausedUntil > Date.now() || !state.enabled) return;

  const canReveal = state.sensitivity !== "strict";

  const wrapper = applyOverlay(el, {
    clickToReveal: canReveal,
    blurRadius: "22px",
    badgeLabel: canReveal ? "Blurred by BlurGuard" : "Blocked by BlurGuard",
  });

  const contextBlur = wrapper
    ? null
    : applyContextBlur(el, {
        clickToReveal: canReveal,
        blurRadius: "10px",
        badgeLabel: canReveal
          ? "Blurred result by BlurGuard"
          : "Blocked result by BlurGuard",
      });

  if (!wrapper && !contextBlur) return;

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

  startDetector(({ element }) => {
    void scanElement(element);
  }, document.body);
}

function stopScanning(): void {
  stopDetector();
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

  const ready = await waitForMediaReady(el, 10_000);
  if (!ready) return;
  if (state.pausedUntil > Date.now() || !state.enabled) return;

  const url = resolveClassifyUrl(el);

  if (!url) {
    // No src yet (e.g. lazy-load not yet triggered) — retry once.
    if (allowRetry && !retried.has(el)) {
      retried.add(el);
      scanned.delete(el);
      window.setTimeout(() => void scanElement(el, false), 2_000);
    }
    return;
  }

  const id = assignStableId(el);
  const kind: "image" | "video" = el instanceof HTMLImageElement ? "image" : "video";
  const sentAt = performance.now();

  pending.set(id, { el, sentAt });

  sendToBackground({
    type: "CLASSIFY_REQUEST",
    payload: { id, url, kind },
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
