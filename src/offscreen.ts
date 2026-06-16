// src/offscreen.ts
// Offscreen document — hidden extension page with DOM + WebGL.
//
// Both inference backends flow through here so images are always fetched as
// the EXTENSION origin (which sees auth-gated content the logged-in user sees),
// not from Sightengine's servers or the SW (which has no fetch credentials).
//
//   tfjs:        fetch → blob → createImageBitmap → canvas → nsfwjs classify
//   sightengine: fetch → blob → POST multipart to Sightengine API
//
// OFFSCREEN_PING responds immediately once the message listener is registered.
// tfjs OFFSCREEN_CLASSIFY waits for modelReady internally before using the GPU.
// sightengine OFFSCREEN_CLASSIFY does not wait for the model at all.

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { load as nsfwLoad, type NSFWJS } from "nsfwjs";

import type {
  OffscreenClassifyMessage,
  OffscreenPingMessage,
  Prediction,
  Sensitivity,
  SightengineConfig,
  SightengineNudity,
  Verdict,
} from "./types/messages";
import { assertNever } from "./types/messages";
import { sightengineClassifyBlob } from "./lib/sightengine";
import { CLOUD_BACKEND_ENABLED } from "./lib/featureFlags";

// ── Model init ────────────────────────────────────────────────────────────────
// Runs in the background at offscreen-doc load time; NOT awaited at PING time.
// tfjs OFFSCREEN_CLASSIFY awaits this before using nsfwModel.

let nsfwModel: NSFWJS | null = null;

const modelReady: Promise<void> = initModel().catch((err) => {
  console.error("[BlurGuard offscreen] init failed:", err);
});

async function initModel(): Promise<void> {
  const t0 = performance.now();
  setWasmPaths(chrome.runtime.getURL("wasm/"));

  try {
    await tf.setBackend("webgl");
    await tf.ready();
    if (tf.getBackend() !== "webgl") {
      throw new Error(`expected webgl, got ${tf.getBackend()}`);
    }
    console.log(`[BlurGuard offscreen] backend: webgl ✓  backendMs=${Math.round(performance.now() - t0)}`);
  } catch (err) {
    console.warn("[BlurGuard offscreen] webgl unavailable, falling back to wasm:", err);
    await tf.setBackend("wasm");
    await tf.ready();
    console.log(`[BlurGuard offscreen] backend: ${tf.getBackend()} ✓  backendMs=${Math.round(performance.now() - t0)}`);
  }

  const tLoad = performance.now();
  const modelUrl = chrome.runtime.getURL("models/nsfwjs/model.json");
  console.log("[BlurGuard offscreen] loading model:", modelUrl);
  nsfwModel = await nsfwLoad(modelUrl, { type: "graph" });
  console.log(`[BlurGuard offscreen] model loaded ✓  loadMs=${Math.round(performance.now() - tLoad)}`);

  const tWarmup = performance.now();
  const dummy = document.createElement("canvas");
  dummy.width = 1;
  dummy.height = 1;
  await nsfwModel.classify(dummy);
  console.log(
    `[BlurGuard offscreen] warmup done ✓  warmupMs=${Math.round(performance.now() - tWarmup)}  totalColdLoadMs=${Math.round(performance.now() - t0)}`
  );
}

// ── Inbound message narrowing ─────────────────────────────────────────────────

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
    return true;
  }
);

async function dispatch(
  message: OffscreenInbound,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case "OFFSCREEN_PING":
      // Respond immediately — message listener is up.
      // The SW's waitForOffscreenReady() will unblock as soon as this returns.
      // tfjs classifies await modelReady inside runClassify(); sightengine does not.
      sendResponse({ type: "OFFSCREEN_READY" });
      return;

    case "OFFSCREEN_CLASSIFY": {
      const { id, url, backend, sensitivity, sightengineConfig } = message.payload;
      const result = await runClassify(url, backend, sensitivity, sightengineConfig);
      sendResponse({ id, ...result });
      return;
    }

    default:
      assertNever(message);
  }
}

// ── Inference queue (tfjs only) ───────────────────────────────────────────────
//
// WebGL is a serial GPU resource — concurrent classify() calls would staircase.
// The queue serialises tfjs inference while allowing decode and sightengine HTTP
// calls to run concurrently.
//
//   queueTail:   non-rejecting promise chain; errors caught inline.
//   urlInFlight: URL → shared result; concurrent requests for the same URL
//                coalesce into one GPU pass.
//   queueDepth:  distinct URLs waiting + the one running.  Coalesced duplicates
//                do NOT count.  At MAX_QUEUE_DEPTH novel URLs are dropped.

const MAX_QUEUE_DEPTH = 100;

type SharedResult = { predictions: Prediction[]; inferenceMs: number };

let queueTail: Promise<void> = Promise.resolve();
let queueDepth = 0;
const urlInFlight = new Map<string, Promise<SharedResult>>();

// ── Result types ──────────────────────────────────────────────────────────────
//
// tfjs:        predictions set; SW applies NSFWJS thresholds.
// sightengine: verdict set (success) OR cloudError set (failure).
// cloudError is propagated verbatim to the SW which records it in the feed and
// tracks consecutive failures — the offscreen does NOT decide the fail policy.

type ClassifyResult = {
  predictions?: Prediction[];  // tfjs path
  verdict?: Verdict;           // sightengine success
  nudity?: SightengineNudity;  // sightengine raw scores — forwarded to SW for caching
  cloudError?: string;         // sightengine failure — raw reason, no verdict
  decodeMs: number;
  inferenceMs: number;
  queueWaitMs: number;
};

// ── Entry point ───────────────────────────────────────────────────────────────

async function runClassify(
  url: string,
  backend: "tfjs" | "sightengine",
  sensitivity: Sensitivity,
  sightengineConfig?: SightengineConfig,
): Promise<ClassifyResult> {
  // ── Phase A: fetch image as extension origin ──────────────────────────────
  // Parallel-safe: network I/O does not touch the GPU or Sightengine's quota.
  const t0 = performance.now();

  let blob: Blob;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      console.warn("[BlurGuard offscreen] fetch non-OK:", response.status, url);
      return { predictions: safeDefault(), decodeMs: 0, inferenceMs: 0, queueWaitMs: 0 };
    }
    blob = await response.blob();
  } catch (err) {
    console.warn("[BlurGuard offscreen] fetch failed:", url, err);
    return { predictions: safeDefault(), decodeMs: 0, inferenceMs: 0, queueWaitMs: 0 };
  }

  const fetchMs = Math.round(performance.now() - t0);

  // ── Phase B: fork on backend ──────────────────────────────────────────────

  if (backend === "sightengine") {
    // CLOUD_BACKEND_ENABLED is false in v1 — this guard is always true, making the
    // runSightengineClassify() call below unreachable dead code that Rollup eliminates.
    if (!CLOUD_BACKEND_ENABLED) {
      return { cloudError: "Cloud backend disabled in this build", decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
    }
    return runSightengineClassify(blob, fetchMs, sensitivity, sightengineConfig);
  }

  return runTfjsClassify(url, blob, fetchMs);
}

// ── Sightengine path ──────────────────────────────────────────────────────────
// No GPU queue needed — pure HTTP.  Returns a pre-computed Verdict so the SW
// does not apply NSFWJS thresholds to Sightengine's output.

async function runSightengineClassify(
  blob: Blob,
  fetchMs: number,
  sensitivity: Sensitivity,
  config?: SightengineConfig,
): Promise<ClassifyResult> {
  // Missing credentials is a configuration error, not an API failure — surface it
  // the same way so the SW can record it and the user sees it in the feed.
  if (!config) {
    const reason = "Sightengine credentials not configured";
    console.warn("[BlurGuard offscreen] sightengine:", reason);
    return { cloudError: reason, decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  try {
    const { verdict, nudity, inferenceMs } = await sightengineClassifyBlob(blob, config, sensitivity);
    console.log(
      `[BlurGuard offscreen] sightengine  fetchMs=${fetchMs}  inferenceMs=${inferenceMs}` +
      `  verdict=${verdict.category}  block=${verdict.shouldBlock}`
    );
    return { verdict, nudity, decodeMs: fetchMs, inferenceMs, queueWaitMs: 0 };
  } catch (err) {
    // Re-throw as a structured cloudError string — the SW decides the fail policy,
    // not the offscreen.  We do NOT return a safe verdict here (that would hide the gap).
    const reason = err instanceof Error ? err.message : String(err);
    console.error("[BlurGuard offscreen] sightengine classify error:", reason);
    return { cloudError: reason, decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }
}

// ── tfjs path ─────────────────────────────────────────────────────────────────
// Awaits modelReady before GPU work.  Serialised through the queue.

async function runTfjsClassify(
  url: string,
  blob: Blob,
  fetchMs: number,
): Promise<ClassifyResult> {
  // Block until backend + model + warmup complete (first call only; no-op after).
  await modelReady;

  // Decode blob → HTMLImageElement.  tf.browser.fromPixels(img) reads the image's
  // raw decoded bytes directly.  The old createImageBitmap → 2D-canvas path ran the
  // pixels through the canvas compositor which premultiplied the alpha channel —
  // zeroing RGB wherever alpha < 255 — and collapsed all real photographs to ~97%
  // Drawing because the model received a near-zero tensor.
  // SVGs fail img.onload in an offscreen doc without explicit size attributes.
  if (blob.type === "image/svg+xml" || blob.type === "image/svg") {
    return { predictions: safeDefault(), decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise<void>((res, rej) => {
      img.onload  = () => res();
      img.onerror = () => rej(new Error("img load failed"));
      img.src = objectUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    console.warn("[BlurGuard offscreen] image decode failed:", err, "type:", blob.type, "size:", blob.size);
    return { predictions: safeDefault(), decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }
  // Safe to revoke immediately — the browser already decoded into GPU/CPU memory.
  // tf.browser.fromPixels(img) reads from the decoded pixel data, not the URL.
  URL.revokeObjectURL(objectUrl);

  // Coalesce: same URL already queued or running — share the classify() result.
  const inflight = urlInFlight.get(url);
  if (inflight) {
    const shared = await inflight;
    console.log(`[BlurGuard offscreen] coalesced  decodeMs=${fetchMs}  inferenceMs=0 (shared)`);
    return { predictions: shared.predictions, decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  if (queueDepth >= MAX_QUEUE_DEPTH) {
    console.warn(`[BlurGuard offscreen] queue full (${MAX_QUEUE_DEPTH}), dropping classify`);
    return { predictions: safeDefault(), decodeMs: fetchMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  let resolveShared!: (v: SharedResult) => void;
  const sharedPromise = new Promise<SharedResult>((res) => { resolveShared = res; });
  urlInFlight.set(url, sharedPromise);
  queueDepth++;

  const tEnqueued = performance.now();

  return new Promise<ClassifyResult>((resolveOuter) => {
    queueTail = queueTail.then(async () => {
      const queueWaitMs = Math.round(performance.now() - tEnqueued);
      let predictions: Prediction[] = safeDefault();
      let inferenceMs = 0;
      try {
        const tInfer = performance.now();
        const raw = await nsfwModel!.classify(img);
        inferenceMs = Math.round(performance.now() - tInfer);
        predictions = raw as Prediction[];
      } catch (err) {
        // Do NOT re-throw — a thrown error here would deadlock the queue chain.
        console.warn("[BlurGuard offscreen] classify() failed:", err);
      } finally {
        urlInFlight.delete(url);
        queueDepth--;
      }
      console.log(
        `[BlurGuard offscreen] tfjs  decodeMs=${fetchMs}  queueWaitMs=${queueWaitMs}  inferenceMs=${inferenceMs}`
      );
      resolveShared({ predictions, inferenceMs });
      resolveOuter({ predictions, decodeMs: fetchMs, inferenceMs, queueWaitMs });
    });
  });
}

function safeDefault(): Prediction[] {
  return [
    { className: "Neutral", probability: 1 },
    { className: "Drawing", probability: 0 },
    { className: "Hentai",  probability: 0 },
    { className: "Porn",    probability: 0 },
    { className: "Sexy",    probability: 0 },
  ];
}

