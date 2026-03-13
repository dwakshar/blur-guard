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

  ensureStyles(options.blurRadius ?? "20px");

  const wrapper = buildWrapper(el, options);
  if (!wrapper) return null;

  // Swap el for wrapper in the DOM without layout shift
  el.parentNode?.insertBefore(wrapper, el);
  wrapper.prepend(el); // el is now first child of wrapper

  return wrapper;
}

/**
 * Remove the overlay from an element and restore it to its original DOM position.
 * Idempotent — safe to call on unwrapped elements.
 */
export function removeOverlay(el: MediaElement): void {
  const wrapper = el.closest<HTMLDivElement>("[data-bg-wrapper]");
  if (!wrapper) return;

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
      const media = wrapper.querySelector<MediaElement>("img, video");
      if (media) {
        wrapper.parentNode?.insertBefore(media, wrapper);
      }
      wrapper.remove();
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
  `.replace(/20px/g, blurRadius); // honour custom blurRadius in CSS too

  (document.head ?? document.documentElement).appendChild(style);
}
