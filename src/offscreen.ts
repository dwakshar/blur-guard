// src/offscreen.ts
// Offscreen document — hidden extension page with DOM + WebGL.
// Phase 1.2: local WASM paths, WebGL→WASM backend fallback, local model load,
// warmup inference, OFFSCREEN_READY gated on model-loaded-and-warmed.
//
// Why here and not the SW or content script?
//   SW:             no DOM, no WebGL → TF.js WebGL backend fails at init
//   content script: subject to host-page CSP and canvas cross-origin taint
//   offscreen doc:  DOM + WebGL + extension CSP + host_permissions for fetch → safe

import * as tf from "@tensorflow/tfjs";
// setWasmPaths is exported by the wasm backend package, not the core tf package.
// The side-effect import also registers the backend in the TF.js registry so the
// fallback path is available even when WebGL wins the selection race.
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { load as nsfwLoad, type NSFWJS } from "nsfwjs";

import type {
  OffscreenClassifyMessage,
  OffscreenPingMessage,
  Prediction,
} from "./types/messages";
import { assertNever } from "./types/messages";

// ── Model init ────────────────────────────────────────────────────────────────
// Runs once at offscreen-doc load time and is kept warm for the doc's lifetime.
// All OFFSCREEN_CLASSIFY messages are gated behind modelReady via the PING/READY
// handshake — the SW will not forward classify requests until we say we're ready.

let nsfwModel: NSFWJS | null = null;

// Top-level promise that resolves only after backend + model + warmup are done.
const modelReady: Promise<void> = initModel().catch((err) => {
  // Surface init failures in the offscreen devtools console; the SW will time out
  // on OFFSCREEN_PING and retry createDocument() on the next classify request.
  console.error("[BlurGuard offscreen] init failed:", err);
});

async function initModel(): Promise<void> {
  // ① WASM paths — must be set BEFORE tf.setBackend() / tf.ready().
  //   TF.js caches path resolution at backend-init time; calling setWasmPaths()
  //   after ready() has no effect on an already-initialised WASM backend.
  //   chrome.runtime.getURL("wasm/") → "chrome-extension://<id>/wasm/"
  //   TF.js appends the bare filenames:  …/tfjs-backend-wasm.wasm  etc.
  setWasmPaths(chrome.runtime.getURL("wasm/"));

  // ② Backend selection — WebGL first (GPU conv ~10× faster than WASM).
  //   On headless / software-GL environments the setBackend call succeeds but
  //   getBackend() may return something other than "webgl", so we check both.
  try {
    await tf.setBackend("webgl");
    await tf.ready();
    if (tf.getBackend() !== "webgl") {
      throw new Error(`expected webgl, got ${tf.getBackend()}`);
    }
    console.log("[BlurGuard offscreen] backend: webgl ✓");
  } catch (err) {
    console.warn(
      "[BlurGuard offscreen] webgl unavailable, falling back to wasm:",
      err
    );
    await tf.setBackend("wasm");
    await tf.ready();
    console.log("[BlurGuard offscreen] backend:", tf.getBackend(), "✓");
  }

  // ③ Load model from the extension's own origin — never the CDN default.
  //   Bundled at public/models/nsfwjs/model.json + two weight shards.
  const modelUrl = chrome.runtime.getURL("models/nsfwjs/model.json");
  console.log("[BlurGuard offscreen] loading model:", modelUrl);
  // type:'graph' → tf.loadGraphModel. Without it nsfwjs defaults to
  // tf.loadLayersModel, which rejects our graph-model format JSON with
  // "Improper config format".
  nsfwModel = await nsfwLoad(modelUrl, { type: "graph" });
  console.log("[BlurGuard offscreen] model loaded ✓");

  // ④ Warmup inference on a 1×1 dummy canvas.
  //   First classify() call triggers GLSL shader compilation (WebGL) or WASM JIT.
  //   Running it now means the first REAL image pays zero cold-start cost.
  const dummy = document.createElement("canvas");
  dummy.width = 1;
  dummy.height = 1;
  await nsfwModel.classify(dummy);
  console.log("[BlurGuard offscreen] warmup done — OFFSCREEN_READY ✓");
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
    return true; // keep port open for async sendResponse
  }
);

async function dispatch(
  message: OffscreenInbound,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case "OFFSCREEN_PING":
      // Block until backend + model + warmup are complete.
      // SW sends this immediately after createDocument() and will not forward
      // OFFSCREEN_CLASSIFY messages until it receives OFFSCREEN_READY here.
      await modelReady;
      sendResponse({ type: "OFFSCREEN_READY" });
      return;

    case "OFFSCREEN_CLASSIFY": {
      const { id, url, kind } = message.payload;
      const { predictions, decodeMs, inferenceMs, queueWaitMs } = await runClassify(url, kind);
      sendResponse({ id, predictions, decodeMs, inferenceMs, queueWaitMs });
      return;
    }

    default:
      assertNever(message);
  }
}

// ── Inference queue ───────────────────────────────────────────────────────────
//
// WebGL is a serial GPU resource. Letting concurrent classify() calls race
// produces the "staircase" effect: every caller blocks on the others and reports
// (wait + work) as inferenceMs. The queue below fixes this:
//
//   queueTail   — non-rejecting promise chain. Each item appends a .then();
//                 errors are caught inline so a failed classify() never deadlocks
//                 the chain for subsequent items.
//
//   urlInFlight — URL → shared classify result. Concurrent requests for the SAME
//                 URL coalesce into one GPU pass (strategy: COALESCE duplicates).
//                 Entry is deleted as soon as classify() finishes.
//
//   queueDepth  — count of distinct URLs currently waiting + the one running.
//                 Coalesced duplicates do NOT increment this counter. If depth
//                 reaches MAX_QUEUE_DEPTH, new distinct URLs are dropped and a
//                 safe-default returned (strategy: DROP extras).
//
// With this design inferenceMs = pure GPU work, queueWaitMs = serialisation
// overhead, and both numbers are honest independent measurements.

const MAX_QUEUE_DEPTH = 100;

type SharedResult = { predictions: Prediction[]; inferenceMs: number };

let queueTail: Promise<void> = Promise.resolve();
let queueDepth = 0;
const urlInFlight = new Map<string, Promise<SharedResult>>();

// ── Real inference ────────────────────────────────────────────────────────────

type ClassifyResult = {
  predictions: Prediction[];
  decodeMs: number;     // fetch + blob + createImageBitmap
  inferenceMs: number;  // nsfwjs.classify() GPU work only
  queueWaitMs: number;  // canvas-ready → classify() slot acquired (0 when coalesced)
};

async function runClassify(
  url: string,
  kind: "image" | "video"
): Promise<ClassifyResult> {
  if (kind === "video") {
    // Frame extraction needs a <video> element + autoplay + seeking. Deferred.
    console.warn("[BlurGuard offscreen] video inference not yet implemented");
    return { predictions: safeDefault(), decodeMs: 0, inferenceMs: 0, queueWaitMs: 0 };
  }

  // ── Phase A: fetch + decode ───────────────────────────────────────────────
  // Parallel-safe: network I/O and CPU decode do not touch the GPU. Multiple
  // fetches can run concurrently while one classify() holds the queue.
  const t0 = performance.now();

  let bitmap: ImageBitmap;
  let width: number;
  let height: number;
  try {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) {
      console.warn("[BlurGuard offscreen] fetch non-OK:", response.status, url);
      return { predictions: safeDefault(), decodeMs: 0, inferenceMs: 0, queueWaitMs: 0 };
    }
    bitmap = await createImageBitmap(await response.blob());
    width = bitmap.width;
    height = bitmap.height;
  } catch (err) {
    console.warn("[BlurGuard offscreen] fetch/decode failed:", url, err);
    return { predictions: safeDefault(), decodeMs: 0, inferenceMs: 0, queueWaitMs: 0 };
  }

  // Draw to canvas: nsfwjs internally calls tf.browser.fromPixels, which
  // accepts HTMLCanvasElement reliably across all backends; raw ImageBitmap
  // support varies by TF.js version and backend.
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close(); // release GPU-side memory — do not touch bitmap after this

  const decodeMs = Math.round(performance.now() - t0);

  // ── Phase B: enqueue for classify ─────────────────────────────────────────

  // Coalesce: same URL is already queued or running — share the classify() result.
  // This caller paid for fetch+decode but skips the GPU queue. inferenceMs = 0
  // because no additional GPU work is attributed to this request.
  const inflight = urlInFlight.get(url);
  if (inflight) {
    const shared = await inflight;
    console.log(
      `[BlurGuard offscreen] coalesced  decode ${decodeMs}ms  inferenceMs=0 (shared)`
    );
    return { predictions: shared.predictions, decodeMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  // Backpressure: drop novel URLs when the queue is saturated.
  if (queueDepth >= MAX_QUEUE_DEPTH) {
    console.warn(
      `[BlurGuard offscreen] queue full (${MAX_QUEUE_DEPTH}), dropping classify`
    );
    return { predictions: safeDefault(), decodeMs, inferenceMs: 0, queueWaitMs: 0 };
  }

  // Register the shared promise BEFORE incrementing the tail so any concurrent
  // arrival for the same URL sees it immediately and takes the coalesce path.
  let resolveShared!: (v: SharedResult) => void;
  const sharedPromise = new Promise<SharedResult>((res) => {
    resolveShared = res;
  });
  urlInFlight.set(url, sharedPromise);
  queueDepth++;

  // tEnqueued stamps when THIS canvas is ready and waiting for the GPU slot.
  // queueWaitMs = time spent waiting; inferenceMs = time inside classify().
  const tEnqueued = performance.now();

  // nsfwModel is guaranteed non-null: SW only sends OFFSCREEN_CLASSIFY after
  // receiving OFFSCREEN_READY, which is sent only after modelReady resolves.
  return new Promise<ClassifyResult>((resolveOuter) => {
    queueTail = queueTail.then(async () => {
      const queueWaitMs = Math.round(performance.now() - tEnqueued);
      let predictions: Prediction[] = safeDefault();
      let inferenceMs = 0;
      try {
        const tInfer = performance.now();
        const raw = await nsfwModel!.classify(canvas);
        inferenceMs = Math.round(performance.now() - tInfer);
        predictions = raw as Prediction[];
      } catch (err) {
        // Do NOT re-throw — a thrown error here would reject queueTail and
        // cause every subsequent .then() to be skipped, deadlocking the queue.
        console.warn("[BlurGuard offscreen] classify() failed:", err);
      } finally {
        // Clean up before resolving so new arrivals for this URL don't coalesce
        // onto a stale in-flight entry.
        urlInFlight.delete(url);
        queueDepth--;
      }
      console.log(
        `[BlurGuard offscreen] decode ${decodeMs}ms  queueWait ${queueWaitMs}ms  inference ${inferenceMs}ms`
      );
      resolveShared({ predictions, inferenceMs });
      resolveOuter({ predictions, decodeMs, inferenceMs, queueWaitMs });
      // Return undefined — the queueTail chain's resolved value is intentionally void.
    });
  });
}

// All five nsfwjs class labels returned so the SW's threshold mapping runs
// unchanged against fallback responses (same shape as real predictions).
function safeDefault(): Prediction[] {
  return [
    { className: "Neutral", probability: 1 },
    { className: "Drawing", probability: 0 },
    { className: "Hentai",  probability: 0 },
    { className: "Porn",    probability: 0 },
    { className: "Sexy",    probability: 0 },
  ];
}
