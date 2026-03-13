// src/content.ts
// BlurGuard — Content Script
// Step 3+4: Detects media → classifies via classifier.ts → overlays via blurOverlay.ts

import { applyOverlay, removeAllOverlays } from "./lib/blurOverlay";
import { createClassifier, type Classifier } from "./lib/classifier";
import type { BlurGuardMessage, BlurGuardState } from "./types/messages";

// ─── State ────────────────────────────────────────────────────────────────────

let state: BlurGuardState = {
  enabled: true,
  sensitivity: "balanced",
  feed: [],
  stats: { images: 0, videos: 0, blocked: 0 },
};

const scanned = new WeakSet<Element>();
let classifier: Classifier = createClassifier({
  backend: "pattern",
  sensitivity: state.sensitivity,
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init() {
  const response = await sendToBackground({ type: "GET_STATE" });
  if (response) {
    state = response as BlurGuardState;
    classifier = createClassifier({
      backend: "pattern",
      sensitivity: state.sensitivity,
    });
  }

  if (state.enabled) {
    scanAndBlur();
    observeDOMChanges();
  }
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: BlurGuardMessage) => {
  switch (message.type) {
    case "PROTECTION_TOGGLED":
      state.enabled = message.payload as boolean;
      if (state.enabled) {
        scanAndBlur();
        observeDOMChanges();
      } else {
        removeAllOverlays();
        stopObserver();
      }
      break;

    case "SENSITIVITY_CHANGED":
      state.sensitivity = message.payload as BlurGuardState["sensitivity"];
      classifier.dispose();
      classifier = createClassifier({
        backend: "pattern",
        sensitivity: state.sensitivity,
      });
      removeAllOverlays();
      document
        .querySelectorAll<HTMLElement>("img, video")
        .forEach((el) => scanned.delete(el));
      scanAndBlur();
      break;
  }
});

// ─── Scan & Blur ──────────────────────────────────────────────────────────────

function scanAndBlur(): void {
  if (!state.enabled) return;
  document
    .querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")
    .forEach(scanElement);
}

async function scanElement(
  el: HTMLImageElement | HTMLVideoElement
): Promise<void> {
  if (scanned.has(el)) return;
  scanned.add(el);

  const result = await classifier.classify(el);
  if (!result.explicit) return;

  const wrapper = applyOverlay(el, {
    clickToReveal: true,
    blurRadius: "22px",
    badgeLabel: "Blurred by BlurGuard",
  });

  if (wrapper) {
    sendToBackground({
      type: "REPORT_DETECTION",
      payload: {
        kind: el instanceof HTMLImageElement ? "image" : "video",
        src: el instanceof HTMLImageElement ? el.currentSrc || el.src : el.src,
        confidence: result.confidence,
      },
    });
  }
}

// ─── MutationObserver ─────────────────────────────────────────────────────────

let observer: MutationObserver | null = null;

function observeDOMChanges(): void {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.matches("img, video"))
          scanElement(el as HTMLImageElement | HTMLVideoElement);
        el.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
          "img, video"
        ).forEach(scanElement);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function sendToBackground(message: BlurGuardMessage): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => null);
}

// ─── Run ──────────────────────────────────────────────────────────────────────

init();
