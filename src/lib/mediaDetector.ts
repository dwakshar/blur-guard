// src/lib/mediaDetector.ts
//
// Detects <img> and <video> elements added to the page — including dynamically
// injected ones — with minimal overhead. Uses a WeakSet so scanned elements are
// never visited twice and are garbage-collected normally when removed from DOM.

export type MediaKind = "image" | "video";

export interface DetectedMedia {
  element: HTMLImageElement | HTMLVideoElement;
  kind: MediaKind;
  src: string;
}

export type DetectionCallback = (media: DetectedMedia) => void;

// ─── Internal state ───────────────────────────────────────────────────────────

// WeakSet holds references without preventing GC — zero memory leak risk
const scanned = new WeakSet<Element>();

let observer: MutationObserver | null = null;
let onDetected: DetectionCallback | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start watching the page for images and videos.
 * Safe to call multiple times — re-entrant calls are ignored.
 *
 * @param callback  Called once per new media element found
 * @param root      Observation root (defaults to document.body)
 */
export function startDetector(
  callback: DetectionCallback,
  root: Element = document.body
): void {
  if (observer) return; // already running

  onDetected = callback;

  // Scan everything already present in the DOM before the observer starts
  scanSubtree(root);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      // Only care about nodes being added — ignore attribute/text changes
      if (mutation.type !== "childList") continue;

      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;

        // The added node itself might be an img/video
        checkElement(el);

        // Or it could be a container that holds img/video descendants
        scanSubtree(el);
      }
    }
  });

  observer.observe(root, {
    childList: true, // watch for added/removed children
    subtree: true, // recurse into all descendants
  });
}

/**
 * Stop watching and clean up. The WeakSet is left intact so any
 * already-scanned elements won't be re-processed if startDetector
 * is called again.
 */
export function stopDetector(): void {
  observer?.disconnect();
  observer = null;
  onDetected = null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Scan all img/video elements within a root element.
 * querySelectorAll is a single DOM pass — cheaper than separate img + video calls.
 */
function scanSubtree(root: Element): void {
  const nodes = root.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
    "img, video"
  );
  for (const node of nodes) checkElement(node);
}

/**
 * Check a single element. Guards:
 * 1. Must be img or video
 * 2. Must not have been scanned before (WeakSet lookup is O(1))
 * 3. Must have a resolvable src
 */
function checkElement(el: Element): void {
  if (scanned.has(el)) return; // already processed — skip immediately
  if (!isMedia(el)) return;

  // Mark before doing anything else so re-entrant mutations can't double-fire
  scanned.add(el);

  const src = resolveSrc(el);
  if (!src) return; // no src yet — e.g. lazy-loaded image not yet triggered

  onDetected?.({
    element: el as HTMLImageElement | HTMLVideoElement,
    kind: el.tagName === "IMG" ? "image" : "video",
    src,
  });
}

function isMedia(el: Element): el is HTMLImageElement | HTMLVideoElement {
  const tag = el.tagName;
  return tag === "IMG" || tag === "VIDEO";
}

function resolveSrc(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }
  // For video, prefer <source> child if the video src attr is empty
  if (el.src) return el.src;
  const source = el.querySelector("source");
  return source?.src || source?.getAttribute("src") || "";
}
