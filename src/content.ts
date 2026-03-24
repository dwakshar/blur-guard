// src/content.ts
// BlurGuard - Content Script
// Detects media via mediaDetector.ts, classifies it, and applies overlays.

import { applyContextBlur, applyOverlay, removeAllOverlays } from "./lib/blurOverlay";
import { createClassifier, type Classifier } from "./lib/classifier";
import { startDetector, stopDetector } from "./lib/mediaDetector";
import type {
  BlurGuardMessage,
  BlurGuardState,
  Sensitivity,
} from "./types/messages";

const CONTENT_SCRIPT_FLAG = "__blurGuardContentScriptLoaded__";

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

const scanned = new WeakSet<Element>();
const retried = new WeakSet<Element>();

let classifier: Classifier = createContentClassifier(state.sensitivity);

async function bootstrap() {
  const response = await sendToBackground({ type: "GET_STATE" });
  if (response) {
    state = response as BlurGuardState;
    classifier.dispose();
    classifier = createContentClassifier(state.sensitivity);
  }

  chrome.runtime.onMessage.addListener(handleMessage);

  if (state.enabled && state.pausedUntil <= Date.now()) {
    scanAndBlur();
    startScanning();
  } else {
    stopScanning();
  }
}

async function handleMessage(message: BlurGuardMessage) {
  switch (message.type) {
    case "PROTECTION_TOGGLED": {
      const latestState = await sendToBackground({ type: "GET_STATE" });
      if (latestState) {
        state = latestState as BlurGuardState;
      } else {
        state.enabled = message.payload as boolean;
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
      return;
    }

    case "SENSITIVITY_CHANGED":
      state.sensitivity = message.payload as BlurGuardState["sensitivity"];
      classifier.dispose();
      classifier = createContentClassifier(state.sensitivity);
      removeAllOverlays();
      document
        .querySelectorAll<HTMLElement>("img, video")
        .forEach((el) => scanned.delete(el));
      scanAndBlur();
      return;
  }
}

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
  document
    .querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")
    .forEach((el) => {
      void scanElement(el);
    });
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

  const result = await classifier.classify(el);

  if (
    allowRetry &&
    result.confidence === 0 &&
    hasValidSource(el) &&
    !retried.has(el)
  ) {
    retried.add(el);
    scanned.delete(el);
    window.setTimeout(() => {
      void scanElement(el, false);
    }, 2_000);
    return;
  }

  if (!result.shouldBlock) return;

  const canReveal = state.sensitivity !== "strict";

  const wrapper = applyOverlay(el, {
    clickToReveal: canReveal,
    blurRadius: "22px",
    badgeLabel: canReveal
      ? "Blurred by BlurGuard"
      : "Blocked by BlurGuard",
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
      category: result.category,
      confidence: result.confidence,
      reasons: result.reasons,
    },
  });
}

function waitForMediaReady(
  el: HTMLImageElement | HTMLVideoElement,
  timeoutMs: number
): Promise<boolean> {
  if (el instanceof HTMLImageElement) {
    if (el.complete && el.naturalWidth > 0) {
      return Promise.resolve(true);
    }

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

  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    return Promise.resolve(true);
  }

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

function resolveSource(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }

  if (el.currentSrc || el.src) {
    return el.currentSrc || el.src;
  }

  const source = el.querySelector("source");
  return source?.src || source?.getAttribute("src") || "";
}

function hasValidSource(el: HTMLImageElement | HTMLVideoElement): boolean {
  return resolveSource(el).trim().length > 0;
}

function createContentClassifier(
  sensitivity: Sensitivity
): Classifier {
  return createClassifier({
    backend: "pattern",
    sensitivity,
  });
}

function sendToBackground(message: BlurGuardMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => null);
}
