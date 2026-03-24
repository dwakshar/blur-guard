// src/lib/blurOverlay.ts
//
// Wraps flagged <img> and <video> elements in a position-preserving overlay
// that blurs the media without causing layout shifts.
//
// Architecture:
//   <div class="bg-wrapper">        ← replaces the element in flow (same size)
//     <img ... />                   ← original element, moved inside wrapper
//     <div class="bg-overlay">      ← absolutely positioned blur glass pane
//       <div class="bg-badge" />    ← "Blurred by BlurGuard" label
//     </div>
//   </div>
//
// Click-to-reveal temporarily hides the overlay; a second click restores it.

// ─── Types ────────────────────────────────────────────────────────────────────

export type MediaElement = HTMLImageElement | HTMLVideoElement;

export interface BlurOverlayOptions {
  /** Show a "click to reveal" hint on the overlay. Default: true */
  clickToReveal?: boolean;
  /** CSS blur radius applied to the media. Default: '20px' */
  blurRadius?: string;
  /** Label text shown on the overlay badge. Default: 'Blurred by BlurGuard' */
  badgeLabel?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const STYLE_ID = "bg-overlay-styles";
const WRAPPER_ATTR = "data-bg-wrapped"; // marks already-wrapped elements
const REVEALED_ATTR = "data-bg-revealed"; // marks temporarily revealed overlays
const CONTEXT_ATTR = "data-bg-context-blurred";
const CONTEXT_UI_ATTR = "data-bg-context-ui";
const resizeObservers = new WeakMap<HTMLDivElement, ResizeObserver>();
const MIN_MEDIA_OVERLAY_EDGE = 56;
const MIN_MEDIA_OVERLAY_AREA = 8_000;
const SEARCH_RESULT_SELECTORS = [
  "[data-sokoban-container]",
  "[data-hveid]",
  ".g",
  ".MjjYud",
  ".tF2Cxc",
  "article",
  "li",
].join(",");

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Wrap a media element with a blur overlay.
 * Idempotent — calling twice on the same element is a no-op.
 *
 * @returns The wrapper <div>, or null if the element was already wrapped
 *          or has no renderable dimensions yet.
 */
export function applyOverlay(
  el: MediaElement,
  options: BlurOverlayOptions = {}
): HTMLDivElement | null {
  // Guard: already wrapped
  if (el.hasAttribute(WRAPPER_ATTR) || el.closest("[data-bg-wrapper]"))
    return null;
  if (shouldSkipMediaOverlay(el)) return null;

  ensureStyles(options.blurRadius ?? "20px");

  const wrapper = buildWrapper(el, options);
  if (!wrapper) return null;

  // Swap el for wrapper in the DOM without layout shift
  el.parentNode?.insertBefore(wrapper, el);
  wrapper.prepend(el); // el is now first child of wrapper
  attachResizeObserver(wrapper, el);

  return wrapper;
}

export function applyContextBlur(
  el: MediaElement,
  options: BlurOverlayOptions = {}
): HTMLElement | null {
  const { clickToReveal = true } = options;
  const container = findContextContainer(el);
  if (!container || container.hasAttribute(CONTEXT_ATTR)) {
    return null;
  }

  ensureStyles(options.blurRadius ?? "20px");
  container.setAttribute(CONTEXT_ATTR, "1");

  const computed = window.getComputedStyle(container);
  if (computed.position === "static") {
    container.style.position = "relative";
  }

  const toggle = document.createElement(clickToReveal ? "button" : "div");
  if (toggle instanceof HTMLButtonElement) {
    toggle.type = "button";
  }
  toggle.setAttribute(CONTEXT_UI_ATTR, "1");
  toggle.textContent = options.badgeLabel ?? "Blurred result by BlurGuard";

  Object.assign(toggle.style, {
    position: "absolute",
    top: "8px",
    left: "8px",
    zIndex: "2147483646",
    fontSize: "10px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontWeight: "700",
    letterSpacing: "0.03em",
    color: "rgba(255,255,255,0.88)",
    padding: "5px 8px",
    borderRadius: "999px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(18,18,18,0.82)",
    backdropFilter: "blur(8px)",
    WebkitBackdropFilter: "blur(8px)",
    cursor: clickToReveal ? "pointer" : "default",
  });

  if (clickToReveal) {
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();

      if (container.hasAttribute(REVEALED_ATTR)) {
        container.removeAttribute(REVEALED_ATTR);
        toggle.textContent = options.badgeLabel ?? "Blurred result by BlurGuard";
      } else {
        container.setAttribute(REVEALED_ATTR, "1");
        toggle.textContent = "Click to hide again";
      }
    });
  }

  container.appendChild(toggle);
  return container;
}

/**
 * Remove the overlay from an element and restore it to its original DOM position.
 * Idempotent — safe to call on unwrapped elements.
 */
export function removeOverlay(el: MediaElement): void {
  const wrapper = el.closest<HTMLDivElement>("[data-bg-wrapper]");
  if (!wrapper) return;

  resizeObservers.get(wrapper)?.disconnect();
  resizeObservers.delete(wrapper);
  wrapper.parentNode?.insertBefore(el, wrapper);
  wrapper.remove();
}

/**
 * Temporarily reveal the media under an overlay (removes blur).
 * Calling again on the same element re-applies the overlay.
 * Only has effect when clickToReveal was enabled.
 */
export function toggleReveal(el: MediaElement): void {
  const overlay =
    el.parentElement?.querySelector<HTMLDivElement>(".bg-overlay");
  if (!overlay) return;

  const isRevealed = overlay.hasAttribute(REVEALED_ATTR);
  if (isRevealed) {
    overlay.removeAttribute(REVEALED_ATTR);
    overlay.style.opacity = "1";
    overlay.style.pointerEvents = "auto";
  } else {
    overlay.setAttribute(REVEALED_ATTR, "1");
    overlay.style.opacity = "0";
    overlay.style.pointerEvents = "none";
  }
}

/**
 * Remove all overlays on the page and restore original elements.
 */
export function removeAllOverlays(): void {
  document
    .querySelectorAll<HTMLDivElement>("[data-bg-wrapper]")
    .forEach((wrapper) => {
      resizeObservers.get(wrapper)?.disconnect();
      resizeObservers.delete(wrapper);
      const media = wrapper.querySelector<MediaElement>("img, video");
      if (media) {
        wrapper.parentNode?.insertBefore(media, wrapper);
      }
      wrapper.remove();
    });

  document.querySelectorAll<HTMLElement>(`[${CONTEXT_ATTR}]`).forEach((container) => {
    container.removeAttribute(CONTEXT_ATTR);
    container.removeAttribute(REVEALED_ATTR);
    container.querySelectorAll(`[${CONTEXT_UI_ATTR}]`).forEach((node) => node.remove());
  });
}

// ─── DOM Builders ─────────────────────────────────────────────────────────────

function buildWrapper(
  el: MediaElement,
  options: BlurOverlayOptions
): HTMLDivElement | null {
  const { clickToReveal = true, badgeLabel = "Blurred by BlurGuard" } = options;

  // Capture computed dimensions before moving element
  const computed = window.getComputedStyle(el);
  const width = el.offsetWidth || parseFloat(computed.width) || 0;
  const height = el.offsetHeight || parseFloat(computed.height) || 0;

  // If the element isn't in the layout yet (e.g. lazy-loaded, display:none),
  // use naturalWidth/naturalHeight for images as a fallback
  const finalW =
    width > 0 ? width : el instanceof HTMLImageElement ? el.naturalWidth : 0;
  const finalH =
    height > 0 ? height : el instanceof HTMLImageElement ? el.naturalHeight : 0;
  if (
    finalW < MIN_MEDIA_OVERLAY_EDGE ||
    finalH < MIN_MEDIA_OVERLAY_EDGE ||
    finalW * finalH < MIN_MEDIA_OVERLAY_AREA
  ) {
    return null;
  }

  // ── Wrapper — takes the element's place in flow ──────────────────────────
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-bg-wrapper", "1");
  wrapper.setAttribute(WRAPPER_ATTR, "1");

  // Mirror display mode: block for images, inline-block for inline images
  const display =
    computed.display === "inline"
      ? "inline-block"
      : computed.display || "block";

  Object.assign(wrapper.style, {
    position: "relative",
    display,
    // Preserve element dimensions explicitly to prevent layout shift
    width: finalW > 0 ? `${finalW}px` : computed.width,
    height: finalH > 0 ? `${finalH}px` : computed.height,
    maxWidth: computed.maxWidth !== "none" ? computed.maxWidth : "100%",
    maxHeight: computed.maxHeight !== "none" ? computed.maxHeight : "",
    margin: computed.margin,
    flexShrink: computed.flexShrink,
    flexGrow: computed.flexGrow,
    alignSelf: computed.alignSelf,
    overflow: "hidden",
    borderRadius: computed.borderRadius,
  });

  // Make the media itself fill the wrapper
  el.style.width = "100%";
  el.style.height = "100%";
  el.style.display = "block";
  el.setAttribute(WRAPPER_ATTR, "1");

  // ── Overlay pane ─────────────────────────────────────────────────────────
  const overlay = document.createElement("div");
  overlay.className = "bg-overlay";

  Object.assign(overlay.style, {
    position: "absolute",
    inset: "0",
    backdropFilter: `blur(${options.blurRadius ?? "20px"})`,
    WebkitBackdropFilter: `blur(${options.blurRadius ?? "20px"})`,
    background: "rgba(0,0,0,0.45)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    transition: "opacity 0.25s ease",
    zIndex: "2147483646", // just below Chrome's max z-index
    cursor: clickToReveal ? "pointer" : "default",
  });

  // ── Shield icon (inline SVG — no external deps needed in content script) ──
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  Object.assign(icon.style, {
    width: "22px",
    height: "22px",
    color: "#ff1a6b",
    filter: "drop-shadow(0 0 6px #ff1a6b88)",
  });

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z");
  icon.appendChild(path);

  // ── Badge label ──────────────────────────────────────────────────────────
  const badge = document.createElement("span");
  badge.className = "bg-badge";
  badge.textContent = badgeLabel;
  Object.assign(badge.style, {
    fontSize: "10px",
    fontFamily: "system-ui, -apple-system, sans-serif",
    fontWeight: "600",
    letterSpacing: "0.04em",
    color: "rgba(255,255,255,0.85)",
    textAlign: "center",
    padding: "2px 6px",
    borderRadius: "4px",
    background: "rgba(0,0,0,0.4)",
    userSelect: "none",
    pointerEvents: "none",
  });

  // ── Reveal hint ──────────────────────────────────────────────────────────
  if (clickToReveal) {
    const hint = document.createElement("span");
    hint.className = "bg-hint";
    hint.textContent = "Click to reveal";
    Object.assign(hint.style, {
      fontSize: "9px",
      fontFamily: "system-ui, -apple-system, sans-serif",
      color: "rgba(255,255,255,0.45)",
      letterSpacing: "0.03em",
      userSelect: "none",
      pointerEvents: "none",
    });
    overlay.append(icon, badge, hint);

    // Wire up click-to-reveal on the overlay itself
    overlay.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleReveal(el);
    });
  } else {
    overlay.append(icon, badge);
  }

  wrapper.appendChild(overlay);
  return wrapper;
}

function shouldSkipMediaOverlay(el: MediaElement): boolean {
  const rect = el.getBoundingClientRect();
  const width =
    rect.width ||
    el.clientWidth ||
    (el instanceof HTMLImageElement ? el.naturalWidth : 0);
  const height =
    rect.height ||
    el.clientHeight ||
    (el instanceof HTMLImageElement ? el.naturalHeight : 0);
  const area = width * height;

  if (
    width < MIN_MEDIA_OVERLAY_EDGE ||
    height < MIN_MEDIA_OVERLAY_EDGE ||
    area < MIN_MEDIA_OVERLAY_AREA
  ) {
    return true;
  }

  return Boolean(
    el.closest(
      [
        "[role='img']",
        "[aria-label*='logo' i]",
        "[class*='favicon' i]",
        "[class*='logo' i]",
      ].join(",")
    )
  );
}

function findContextContainer(el: MediaElement): HTMLElement | null {
  const candidates = [
    el.closest<HTMLElement>(SEARCH_RESULT_SELECTORS),
    el.closest<HTMLElement>("article"),
    el.closest<HTMLElement>("li"),
    el.closest<HTMLElement>("section"),
  ].filter(Boolean) as HTMLElement[];

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    const text = candidate.textContent?.trim() ?? "";
    if (rect.width < 160 || rect.height < 80) continue;
    if (rect.width > window.innerWidth * 0.95 || rect.height > window.innerHeight * 0.9) continue;
    if (text.length < 20) continue;
    return candidate;
  }

  return null;
}

function attachResizeObserver(
  wrapper: HTMLDivElement,
  el: MediaElement
): void {
  syncWrapperSize(wrapper, el);

  const observer = new ResizeObserver(() => {
    syncWrapperSize(wrapper, el);
  });

  observer.observe(el);
  resizeObservers.set(wrapper, observer);
}

function syncWrapperSize(wrapper: HTMLDivElement, el: MediaElement): void {
  const computed = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const width =
    rect.width ||
    el.offsetWidth ||
    parseFloat(computed.width) ||
    (el instanceof HTMLImageElement ? el.naturalWidth : 0);
  const height =
    rect.height ||
    el.offsetHeight ||
    parseFloat(computed.height) ||
    (el instanceof HTMLImageElement ? el.naturalHeight : 0);

  if (width > 0) {
    wrapper.style.width = `${width}px`;
  }

  if (height > 0) {
    wrapper.style.height = `${height}px`;
  }
}

// ─── Style injection ──────────────────────────────────────────────────────────

/**
 * Inject a minimal stylesheet once. Uses Shadow DOM isolation so the
 * extension styles can't be overridden by the host page's CSS.
 * Falls back to a <style> tag if Shadow DOM is unavailable.
 */
function ensureStyles(blurRadius: string): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* BlurGuard overlay — content script injected */
    [data-bg-wrapper] {
      /* Prevent the host page from accidentally collapsing the wrapper */
      min-width: 1px;
      min-height: 1px;
    }
    [data-bg-wrapper] > img,
    [data-bg-wrapper] > video {
      /* Media fills the wrapper; object-fit is preserved via inline style */
      display: block !important;
      width: 100% !important;
      height: 100% !important;
    }
    .bg-overlay {
      /* Smooth reveal transition */
      will-change: opacity;
    }
    /* Revealed state: overlay hidden, media clickable again */
    .bg-overlay[data-bg-revealed] {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    /* Hover hint on un-revealed overlay */
    .bg-overlay:not([data-bg-revealed]):hover .bg-hint {
      color: rgba(255,255,255,0.7) !important;
    }
    /* Prevent the host page's :hover rules from fighting with us */
    [data-bg-wrapper] > img:hover,
    [data-bg-wrapper] > video:hover {
      filter: none !important;
    }
    [${CONTEXT_ATTR}] {
      overflow: hidden;
      border-radius: 14px;
    }
    [${CONTEXT_ATTR}] > :not([${CONTEXT_UI_ATTR}]):not([data-bg-wrapper]),
    [${CONTEXT_ATTR}] > :not([${CONTEXT_UI_ATTR}]):not([data-bg-wrapper]) * {
      filter: blur(5px) !important;
      transition: filter 0.2s ease, opacity 0.2s ease;
    }
    [${CONTEXT_ATTR}] a,
    [${CONTEXT_ATTR}] button,
    [${CONTEXT_ATTR}] [role="link"] {
      pointer-events: none !important;
    }
    [${CONTEXT_ATTR}][${REVEALED_ATTR}] > :not([${CONTEXT_UI_ATTR}]):not([data-bg-wrapper]),
    [${CONTEXT_ATTR}][${REVEALED_ATTR}] > :not([${CONTEXT_UI_ATTR}]):not([data-bg-wrapper]) * {
      filter: none !important;
    }
    [${CONTEXT_ATTR}][${REVEALED_ATTR}] a,
    [${CONTEXT_ATTR}][${REVEALED_ATTR}] button,
    [${CONTEXT_ATTR}][${REVEALED_ATTR}] [role="link"] {
      pointer-events: auto !important;
    }
  `.replace(/20px/g, blurRadius); // honour custom blurRadius in CSS too

  (document.head ?? document.documentElement).appendChild(style);
}
