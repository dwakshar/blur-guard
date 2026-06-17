// src/lib/videoSampler.ts
// Per-video frame sampler for BlurGuard content script.
//
// ── How it works ──────────────────────────────────────────────────────────────
// Each tracked <video> element gets a SamplerEntry with a setInterval that:
//   1. Draws the current frame to a scaled offscreen canvas.
//   2. Converts to a JPEG data URL (typically 10–40 KB at 480px max-edge).
//   3. Invokes the sendFrame callback → content script sends CLASSIFY_REQUEST.
//      The SW/offscreen classify path is identical to the image path.
//   4. Skips the tick if a previous frame is still in-flight (one-at-a-time per video).
//
// Immediate samples also fire on 'play' and 'seeked': a seek to a new position
// is the most common way explicit content appears mid-stream.
//
// ── Performance / battery tradeoff ────────────────────────────────────────────
// At the defaults (FRAME_SAMPLE_INTERVAL_MS = 4000, MAX_ACTIVE_VIDEO_SAMPLERS = 4):
//   • GPU cost:    up to 4 nsfwjs inferences per 4 s = ~1 inference/s added load.
//                 Each inference is ~20–120 ms depending on WebGL vs WASM backend.
//   • Canvas cost: one 480px canvas draw per tick per video (~0.5–2 ms).
//   • Message cost:~15–45 KB data URL per tick per video over the runtime message bus.
//                 This never hits the network — it stays in-process.
//   • Battery:     Non-trivial on low-power / integrated-GPU devices.
//                 Mitigation A — video frame requests use "low" priority by default;
//                   they yield to in-viewport image requests in the SW queue.
//                 Mitigation B — video playing in-viewport + not paused → "high".
//                 Mitigation C — sampler stops immediately when a video is blurred.
//                 Mitigation D — raise FRAME_SAMPLE_INTERVAL_MS (e.g. 8000) if
//                   battery budget is tight; the tradeoff is later detection.
//
// ── Cross-origin videos ───────────────────────────────────────────────────────
// canvas.drawImage(crossOriginVideo) throws SecurityError (tainted canvas).
// captureVideoFrame() catches this and returns null; the sampler falls back to
// the video's poster URL or src URL for that tick.  Poster/src hits the URL
// cache (Phase 3.1) and avoids a redundant inference after the first sample.

export const FRAME_SAMPLE_INTERVAL_MS = 4_000;
export const MAX_ACTIVE_VIDEO_SAMPLERS = 4;

// nsfwjs resizes inputs to 224 px internally.  480 px gives useful fidelity
// without blowing up data-URL message size.
const CAPTURE_MAX_EDGE = 480;
const CAPTURE_JPEG_QUALITY = 0.72;

export type FramePriority = "high" | "low";

/**
 * Called by VideoFrameSampler when a frame is ready to classify.
 * The content script uses this to add to pending map and send CLASSIFY_REQUEST.
 */
export type SendFrameCallback = (
  frameId: string,
  url: string,
  el: HTMLVideoElement,
  priority: FramePriority
) => void;

interface SamplerEntry {
  intervalId: number;
  pendingFrameId: string | null;
  blurred: boolean;
  unlisten: () => void;
}

// ── VideoFrameSampler ─────────────────────────────────────────────────────────

export class VideoFrameSampler {
  private samplers = new Map<HTMLVideoElement, SamplerEntry>();
  private frameCounter = 0;
  private readonly sendFrame: SendFrameCallback;
  /** Returns true when the given request ID is still in flight. */
  private readonly isPending: (id: string) => boolean;
  /** Returns the set of elements currently near the viewport. */
  private readonly getInViewport: () => WeakSet<Element>;
  /**
   * Called when a 'seeked' event fires on a tracked video.
   * Content script uses this to re-apply pre-blur (the new position is unclassified).
   */
  private readonly seekReblur?: (el: HTMLVideoElement) => void;

  constructor(
    sendFrame: SendFrameCallback,
    isPending: (id: string) => boolean,
    getInViewport: () => WeakSet<Element>,
    seekReblur?: (el: HTMLVideoElement) => void,
  ) {
    this.sendFrame = sendFrame;
    this.isPending = isPending;
    this.getInViewport = getInViewport;
    this.seekReblur = seekReblur;
  }

  get activeCount(): number {
    return this.samplers.size;
  }

  isSampling(el: HTMLVideoElement): boolean {
    return this.samplers.has(el);
  }

  /**
   * Start sampling a video element.
   * No-op if already sampling. Returns false if the cap is reached.
   */
  start(el: HTMLVideoElement): boolean {
    if (this.samplers.has(el)) return true;
    if (this.samplers.size >= MAX_ACTIVE_VIDEO_SAMPLERS) {
      console.debug(
        `[BlurGuard] video sampler cap (${MAX_ACTIVE_VIDEO_SAMPLERS}) reached — skipping`,
        el.src?.slice(0, 60)
      );
      return false;
    }

    // Sample immediately on start (video already has HAVE_CURRENT_DATA by the time
    // content.ts calls start(), so there is a frame available).
    this.doSample(el, null);

    const intervalId = window.setInterval(() => {
      const entry = this.samplers.get(el);
      if (!entry || entry.blurred) {
        this.stop(el);
        return;
      }
      this.doSample(el, entry);
    }, FRAME_SAMPLE_INTERVAL_MS);

    // Seek: re-blur the video (new position is unclassified) then sample immediately.
    const onSeeked = () => {
      const entry = this.samplers.get(el);
      if (!entry || entry.blurred) return;
      // Re-apply pre-blur unconditionally — the new position hasn't been classified yet.
      this.seekReblur?.(el);
      if (entry.pendingFrameId && this.isPending(entry.pendingFrameId)) return;
      this.doSample(el, entry);
    };
    // Play: position unchanged, just sample to catch content that started playing.
    const onPlay = () => {
      const entry = this.samplers.get(el);
      if (!entry || entry.blurred) return;
      if (entry.pendingFrameId && this.isPending(entry.pendingFrameId)) return;
      this.doSample(el, entry);
    };
    el.addEventListener("seeked", onSeeked, { passive: true });
    el.addEventListener("play",   onPlay,   { passive: true });

    const entry: SamplerEntry = {
      intervalId,
      pendingFrameId: null,
      blurred: false,
      unlisten: () => {
        el.removeEventListener("seeked", onSeeked);
        el.removeEventListener("play",   onPlay);
      },
    };
    this.samplers.set(el, entry);
    return true;
  }

  /** Stop sampling a specific video and release its resources. */
  stop(el: HTMLVideoElement): void {
    const entry = this.samplers.get(el);
    if (!entry) return;
    window.clearInterval(entry.intervalId);
    entry.unlisten();
    this.samplers.delete(el);
  }

  /** Stop all active samplers (e.g. on protection disable or page unload). */
  stopAll(): void {
    for (const el of this.samplers.keys()) this.stop(el);
  }

  /**
   * Mark a video as blurred so sampling stops.
   * Called by the content script when a frame verdict comes back shouldBlock=true.
   */
  markBlurred(el: HTMLVideoElement): void {
    const entry = this.samplers.get(el);
    if (entry) entry.blurred = true;
    this.stop(el);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private doSample(el: HTMLVideoElement, entry: SamplerEntry | null): void {
    if (!el.isConnected) { this.stop(el); return; }
    if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    if (entry?.blurred) return;
    // Don't flood: one in-flight request per video.
    if (entry?.pendingFrameId && this.isPending(entry.pendingFrameId)) return;

    const url = captureVideoFrame(el) ?? fallbackUrl(el);
    if (!url) return;

    const frameId = `bg-vf-${Date.now()}-${++this.frameCounter}`;
    const priority: FramePriority = (
      this.getInViewport().has(el) && !el.paused && !el.ended
    ) ? "high" : "low";

    if (entry) entry.pendingFrameId = frameId;

    console.debug(
      `[BlurGuard] video sample frameId=${frameId} priority=${priority}` +
      ` activeVideoSamplers=${this.samplers.size}` +
      ` isDataUrl=${url.startsWith("data:")}`
    );
    this.sendFrame(frameId, url, el, priority);
  }
}

// ── Frame capture ─────────────────────────────────────────────────────────────

/**
 * Draw the current video frame to an offscreen canvas scaled to CAPTURE_MAX_EDGE
 * and return it as a JPEG data URL.
 *
 * Returns null when:
 *   - The video has no current frame (readyState < HAVE_CURRENT_DATA or dimensions = 0).
 *   - The video is cross-origin without CORS headers (canvas becomes tainted →
 *     SecurityError on toDataURL).  Caller should fall back to poster/src URL.
 */
export function captureVideoFrame(el: HTMLVideoElement): string | null {
  if (el.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const vw = el.videoWidth;
  const vh = el.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(vw, vh));
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(vw * scale);
  canvas.height = Math.round(vh * scale);

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", CAPTURE_JPEG_QUALITY);
  } catch {
    // SecurityError: cross-origin video, canvas is tainted.
    return null;
  }
}

function fallbackUrl(el: HTMLVideoElement): string {
  return el.poster || el.currentSrc || el.src || el.querySelector("source")?.src || "";
}
