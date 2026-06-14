// src/offscreen.ts
// Offscreen document — hidden extension page with DOM + WebGL.
// Phase 0.4: stub classifier only. Phase 1 replaces stubClassify() with nsfwjs.
//
// Why here and not the SW or content script?
//   SW:             no DOM, no WebGL → TF.js WebGL backend fails at init
//   content script: subject to host-page CSP and canvas cross-origin taint
//   offscreen doc:  DOM + WebGL + extension CSP + host_permissions for fetch → safe

import type {
  NsfwClassName,
  OffscreenClassifyMessage,
  OffscreenPingMessage,
  Prediction,
} from "./types/messages";
import { assertNever } from "./types/messages";

// ── Inbound message narrowing ─────────────────────────────────────────────────
// Chrome's runtime.onMessage is untyped. Only accept the two message types this
// context is responsible for; silently ACK everything else (state-sync traffic
// routes through the SW and popup, never here).

type OffscreenInbound = OffscreenPingMessage | OffscreenClassifyMessage;

function isOffscreenInbound(msg: unknown): msg is OffscreenInbound {
  if (typeof msg !== "object" || msg === null || !("type" in msg)) return false;
  const t = (msg as { type: unknown }).type;
  return t === "OFFSCREEN_PING" || t === "OFFSCREEN_CLASSIFY";
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (raw: unknown, _sender, sendResponse) => {
    if (!isOffscreenInbound(raw)) {
      sendResponse({ ok: true });
      return true;
    }
    void dispatch(raw, sendResponse);
    return true; // keep port open for async sendResponse
  }
);

async function dispatch(
  message: OffscreenInbound,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case "OFFSCREEN_PING":
      // Confirms the offscreen context is alive. SW sends this right after
      // createDocument() and waits before queuing OFFSCREEN_CLASSIFY messages.
      sendResponse({ type: "OFFSCREEN_READY" });
      return;

    case "OFFSCREEN_CLASSIFY": {
      const { id, url, kind } = message.payload;
      const t0 = performance.now();

      // ── PROOF STEP: fetch + decode ────────────────────────────────────────
      // Fetching from the offscreen doc context means:
      //   • host_permissions ("<all_urls>") apply → no CORS block
      //   • the extension's own CSP governs → no host-page CSP interference
      //   • resulting ImageBitmap is origin-clean → canvas drawImage is safe
      // If this call succeeds, the entire Phase 1 inference fetch path is proven.
      await fetchAndDecode(url, kind);
      // ─────────────────────────────────────────────────────────────────────

      const ms = Math.round(performance.now() - t0);
      const predictions = stubClassify(url);

      sendResponse({ id, predictions, ms });
      return;
    }

    default:
      assertNever(message);
  }
}

// ── Fetch + decode (proof step) ───────────────────────────────────────────────

async function fetchAndDecode(
  url: string,
  kind: "image" | "video"
): Promise<void> {
  let response: Response;
  try {
    // credentials:"omit" — we want the raw asset, not a credentialed session.
    response = await fetch(url, { credentials: "omit" });
  } catch (err) {
    // Network error or invalid URL. Not a wiring failure; stub result still sent.
    console.warn("[BlurGuard offscreen] fetch failed:", url, err);
    return;
  }

  if (!response.ok) {
    console.warn("[BlurGuard offscreen] fetch non-OK:", response.status, url);
    return;
  }

  let blob: Blob;
  try {
    blob = await response.blob();
  } catch (err) {
    console.warn("[BlurGuard offscreen] blob() failed:", err);
    return;
  }

  if (kind === "image") {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(blob);
      // Log dimensions so you can eyeball the decode proof in the offscreen devtools.
      console.log(
        `[BlurGuard offscreen] decoded ${bitmap.width}×${bitmap.height}px image`
      );
    } catch (err) {
      // SVG with <foreignObject>, corrupt file, etc. Not a wiring failure.
      console.warn("[BlurGuard offscreen] createImageBitmap failed:", err);
    } finally {
      bitmap?.close(); // release GPU-side memory immediately
    }
    return;
  }

  // kind === "video": raw blob fetched (proves host_permissions + fetch path).
  // Decoding a video frame requires drawImage from an <video> element, which
  // needs autoplay and a source URL, not a blob. Deferred to Phase 1.
  console.log(
    `[BlurGuard offscreen] fetched video blob (${blob.size} bytes), frame decode deferred`
  );
}

// ── Stub classifier ───────────────────────────────────────────────────────────
// Deterministic fake scores keyed off a URL hash. Neutral is floored at 0.72 so
// the stub never triggers a block and is obviously safe to load in any browser tab.
// Replace this entire function body in Phase 1 with: return nsfwjs.classify(el)
//
// All five nsfwjs class labels are returned so the SW's threshold mapping runs
// unchanged against real and stub predictions alike.

const NSFW_CLASSES: NsfwClassName[] = [
  "Drawing",
  "Hentai",
  "Neutral",
  "Porn",
  "Sexy",
];

// TODO(Phase 1): delete stubClassify entirely — replace call site with nsfwjs.classify(el).
function stubClassify(url: string): Prediction[] {
  // REVERT BEFORE PHASE 1 — visual smoke-test hook only.
  // Any URL whose path or filename contains "blurtest" (case-insensitive) gets a
  // hard-coded explicit verdict so you can confirm the overlay path in a live browser
  // without faking the entire feed. All other URLs keep the unambiguously-safe scores.
  if (/blurtest/i.test(url)) {
    return [
      { className: "Porn",    probability: 0.95 },
      { className: "Hentai",  probability: 0.02 },
      { className: "Sexy",    probability: 0.01 },
      { className: "Neutral", probability: 0.01 },
      { className: "Drawing", probability: 0.01 },
    ];
  }

  const h = djb2(url);

  // Spread a small share of probability across the four non-Neutral classes.
  // All multipliers keep individual scores well below any blocking threshold.
  const drawing = ((h & 0xff) / 255) * 0.08;
  const hentai  = (((h >> 8)  & 0xff) / 255) * 0.06;
  const porn    = (((h >> 16) & 0xff) / 255) * 0.05;
  const sexy    = (((h >> 24) & 0xff) / 255) * 0.07;
  // Neutral gets everything else, then floored so the stub is unambiguously safe.
  const neutral = Math.max(0.72, 1 - drawing - hentai - porn - sexy);

  const raw: Record<NsfwClassName, number> = {
    Drawing: drawing,
    Hentai:  hentai,
    Neutral: neutral,
    Porn:    porn,
    Sexy:    sexy,
  };

  // Re-normalise after the Neutral floor (sum may exceed 1.0).
  const total = NSFW_CLASSES.reduce((s, c) => s + raw[c], 0);
  return NSFW_CLASSES.map((className) => ({
    className,
    probability: raw[className] / total,
  }));
}

// djb2 — fast, good avalanche, no external dep.
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0; // force unsigned 32-bit
  }
  return h;
}
