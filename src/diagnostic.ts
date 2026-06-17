// src/diagnostic.ts
// DIAGNOSTIC HARNESS — throwaway measurement tool, not production code.
// Opened as chrome-extension://[id]/diagnostic.html after build + reload.
// Remove this file and diagnostic.html once resume numbers are captured.
//
// Measurement 1: on-device inferenceMs (same timer as offscreen.ts:310-312).
// Measurement 2: recall and false-positive rate on a labeled corpus.

import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";
import { load as nsfwLoad, type NSFWJS } from "nsfwjs";

import type { Prediction, Sensitivity } from "./types/messages";
import { verdictFromPredictions } from "./lib/classifier";

// ── Types ─────────────────────────────────────────────────────────────────────

type Label = "explicit" | "safe";

interface ImageResult {
  filename: string;
  label: Label;
  blocked: boolean;
  category: string;
  inferenceMs: number;
  Porn: number;
  Hentai: number;
  PornHentaiSum: number;
  Sexy: number;
  Neutral: number;
  Drawing: number;
}

// ── Model shard fetch interceptor — mirrors offscreen.ts ─────────────────────
function patchFetchForShards(modelBase: string): void {
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    if (url.startsWith(modelBase) && url.includes("shard")) {
      const resp = await orig(url, init);
      const { data } = await resp.json() as { data: string };
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    return orig(input, init);
  };
}

// ── Model init — mirrors offscreen.ts:42-73 exactly ──────────────────────────

let nsfwModel: NSFWJS | null = null;

async function initModel(log: (msg: string) => void): Promise<void> {
  const t0 = performance.now();
  setWasmPaths(chrome.runtime.getURL("wasm/"));

  try {
    await tf.setBackend("webgl");
    await tf.ready();
    if (tf.getBackend() !== "webgl") throw new Error(`expected webgl, got ${tf.getBackend()}`);
    log(`Backend: webgl ✓  (${ms(t0)}ms)`);
  } catch (err) {
    log(`WebGL unavailable, falling back to wasm: ${err}`);
    await tf.setBackend("wasm");
    await tf.ready();
    log(`Backend: ${tf.getBackend()} ✓  (${ms(t0)}ms)`);
  }

  const tLoad = performance.now();
  const modelUrl = chrome.runtime.getURL("models/nsfwjs/model.json");
  log(`Loading model from ${modelUrl} …`);
  patchFetchForShards(chrome.runtime.getURL("models/nsfwjs/"));
  nsfwModel = await nsfwLoad(modelUrl, { type: "graph" });
  log(`Model loaded ✓  loadMs=${ms(tLoad)}`);

  // Warmup — mirrors offscreen.ts:66-73.
  const tWarmup = performance.now();
  const dummy = document.createElement("canvas");
  dummy.width = 1;
  dummy.height = 1;
  await nsfwModel.classify(dummy);
  log(`Warmup done ✓  warmupMs=${ms(tWarmup)}  totalColdLoadMs=${ms(t0)}`);
}

// ── Single-image classify — mirrors offscreen.ts decode + inference path ──────
//
// Decode path: Blob → createObjectURL → HTMLImageElement
//   This is the FIXED path (offscreen.ts:263-279). It avoids the old
//   createImageBitmap route that premultiplied alpha and produced ~97% Drawing.
//
// Inference timer: mirrors offscreen.ts:310-312 exactly.
//   const tInfer = performance.now();
//   const raw   = await nsfwModel.classify(img);
//   inferenceMs = Math.round(performance.now() - tInfer);

async function classifyFile(
  file: File,
  sensitivity: Sensitivity,
): Promise<{ inferenceMs: number; result: ImageResult }> {
  // SVG guard — mirrors offscreen.ts:259-261.
  const svgResult = (): ImageResult => {
    const preds: Prediction[] = [
      { className: "Neutral", probability: 1 },
      { className: "Drawing", probability: 0 },
      { className: "Hentai",  probability: 0 },
      { className: "Porn",    probability: 0 },
      { className: "Sexy",    probability: 0 },
    ];
    const v = verdictFromPredictions(preds, sensitivity);
    return makeResult(file, "safe", v.shouldBlock, v.category, 0, preds);
  };

  if (file.type === "image/svg+xml" || file.type === "image/svg") {
    const r = svgResult();
    return { inferenceMs: 0, result: r };
  }

  // Decode — mirrors offscreen.ts:263-279.
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  try {
    await new Promise<void>((res, rej) => {
      img.onload  = () => res();
      img.onerror = () => rej(new Error("img.onload failed"));
      img.src = objectUrl;
    });
  } catch (err) {
    URL.revokeObjectURL(objectUrl);
    console.warn("[diagnostic] decode failed:", file.name, err);
    // Fail-closed: decode error → safe default (same as offscreen.ts:274-275).
    const r = svgResult();
    return { inferenceMs: 0, result: r };
  }
  URL.revokeObjectURL(objectUrl);

  // Inference — EXACT same timer as offscreen.ts:310-312.
  const tInfer = performance.now();
  const raw = await nsfwModel!.classify(img);
  const inferenceMs = Math.round(performance.now() - tInfer);
  const predictions = raw as Prediction[];

  // Verdict — calls the real production function, not a reimplementation.
  const verdict = verdictFromPredictions(predictions, sensitivity);

  const label = labelFromPath(file);
  const r = makeResult(file, label ?? "safe", verdict.shouldBlock, verdict.category, inferenceMs, predictions);
  return { inferenceMs, result: r };
}

function makeResult(
  file: File,
  label: Label,
  blocked: boolean,
  category: string,
  inferenceMs: number,
  predictions: Prediction[],
): ImageResult {
  const by: Partial<Record<string, number>> = {};
  for (const { className, probability } of predictions) by[className] = probability;
  const Porn   = by["Porn"]    ?? 0;
  const Hentai = by["Hentai"]  ?? 0;
  return {
    filename: file.name,
    label,
    blocked,
    category,
    inferenceMs,
    Porn,
    Hentai,
    PornHentaiSum: Math.min(1, Porn + Hentai),
    Sexy:    by["Sexy"]    ?? 0,
    Neutral: by["Neutral"] ?? 0,
    Drawing: by["Drawing"] ?? 0,
  };
}

// ── Label detection from webkitRelativePath ───────────────────────────────────
// webkitRelativePath: "corpus/explicit/img.jpg"  →  label = "explicit"
// Searches all path components so nested folders still work.

function labelFromPath(file: File): Label | null {
  const parts = file.webkitRelativePath.split("/");
  for (const part of parts) {
    if (part.toLowerCase() === "explicit") return "explicit";
    if (part.toLowerCase() === "safe")     return "safe";
  }
  return null;
}

// ── Image-file detection ──────────────────────────────────────────────────────
// Chrome's folder picker returns empty file.type for some formats (e.g. JFIF,
// WebP on some Windows builds). Use extension as the primary gate instead.

const IMAGE_EXTS = new Set([
  "jpg", "jpeg", "jfif", "png", "webp", "gif", "bmp", "avif", "tiff", "tif",
]);

function isImageFile(file: File): boolean {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTS.has(ext) || file.type.startsWith("image/");
}

// ── Corpus run ────────────────────────────────────────────────────────────────

async function runCorpus(
  files: FileList,
  sensitivity: Sensitivity,
  onProgress: (done: number, total: number, latest: ImageResult) => void,
  log: (msg: string) => void,
): Promise<ImageResult[]> {
  const work: Array<{ file: File; label: Label }> = [];
  const skipped: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    if (!isImageFile(f)) { skipped.push(`  [non-image] ${f.webkitRelativePath}`); continue; }
    const label = labelFromPath(f);
    if (!label) { skipped.push(`  [no label]  ${f.webkitRelativePath}`); continue; }
    work.push({ file: f, label });
  }

  const nExplicit = work.filter(w => w.label === "explicit").length;
  const nSafe     = work.filter(w => w.label === "safe").length;
  log(`Corpus scan: ${nExplicit} explicit, ${nSafe} safe, ${skipped.length} skipped`);
  if (skipped.length > 0) {
    log(`Skipped files (first 10):\n${skipped.slice(0, 10).join("\n")}`);
  }
  if (nExplicit === 0) {
    log("⚠  No explicit images found. Check that your folder has an 'explicit' subfolder.");
  }
  log("");

  const results: ImageResult[] = [];
  for (let i = 0; i < work.length; i++) {
    const { file } = work[i]!;
    const { result } = await classifyFile(file, sensitivity);
    results.push(result);
    onProgress(i + 1, work.length, result);
  }
  return results;
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(results: ImageResult[]) {
  const TP = results.filter(r => r.label === "explicit" &&  r.blocked).length;
  const FN = results.filter(r => r.label === "explicit" && !r.blocked).length;
  const FP = results.filter(r => r.label === "safe"     &&  r.blocked).length;
  const TN = results.filter(r => r.label === "safe"     && !r.blocked).length;
  const N  = TP + FN + FP + TN;
  const recall = (TP + FN) > 0 ? (TP / (TP + FN)) * 100 : 0;

  // Latency: skip index 0 (first real image after warmup; task: "discard first inference").
  const timings = results.slice(1).map(r => r.inferenceMs);
  const sorted  = [...timings].sort((a, b) => a - b);
  const median  = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)]! : 0;
  const min     = sorted.length > 0 ? sorted[0]!                              : 0;
  const max     = sorted.length > 0 ? sorted[sorted.length - 1]!              : 0;

  return { TP, FN, FP, TN, N, recall, median, min, max, n: timings.length };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderResults(results: ImageResult[], sensitivity: Sensitivity) {
  const s = computeStats(results);

  const nsfw04 = results.find(r => /nsfw.?04/i.test(r.filename));
  const nsfw04Note = nsfw04
    ? `nsfw-04 → blocked=${nsfw04.blocked}, P+H sum=${pct(nsfw04.PornHentaiSum)}, Drawing=${pct(nsfw04.Drawing)}` +
      (nsfw04.blocked ? " ✅ caught" : " ⚠️ still a miss (Drawing-dominant; cloud catches it)")
    : "(nsfw-04 not found in corpus)";

  document.getElementById("stats")!.innerHTML = `
<h2>▶ Measurement 1 — On-Device Inference Latency</h2>
<p>Sensitivity: <strong>${sensitivity}</strong> &nbsp;|&nbsp;
   n (steady-state, first image discarded): <strong>${s.n}</strong></p>
<table>
  <tr><th>Stat</th><th>Value</th></tr>
  <tr><td><strong>Median inferenceMs ← resume number</strong></td><td><strong>${s.median} ms</strong></td></tr>
  <tr><td>Min</td><td>${s.min} ms</td></tr>
  <tr><td>Max</td><td>${s.max} ms</td></tr>
</table>

<h2>▶ Measurement 2 — Recall &amp; False Positives</h2>
<table>
  <tr><th></th><th>Blocked ✓</th><th>Allowed ✗</th></tr>
  <tr><th>explicit (ground truth)</th><td><strong>TP = ${s.TP}</strong></td><td>FN = ${s.FN}</td></tr>
  <tr><th>safe (ground truth)</th><td>FP = ${s.FP}</td><td><strong>TN = ${s.TN}</strong></td></tr>
</table>
<p>
  RECALL [Y] = TP/(TP+FN) = ${s.TP}/${s.TP+s.FN} = <strong>${s.recall.toFixed(1)}%</strong><br>
  FALSE POSITIVES [Z] = <strong>${s.FP}</strong><br>
  N = <strong>${s.N}</strong>
</p>
<div class="resume-bullet">
  📋 <strong>Resume bullets (copy these):</strong><br>
  • <em>~${s.median}ms on-device inference latency (WebGL, median over ${s.n} images, first discarded for warmup)</em><br>
  • <em>${s.recall.toFixed(0)}% recall, ${s.FP} false positives on ${s.N} labeled images (sensitivity=balanced)</em>
</div>

<h3>nsfw-04 check</h3>
<p>${nsfw04Note}</p>

<h2>▶ Per-Image Table</h2>
<p>Sort: misses → FPs → TPs → TNs. Red = miss, yellow = false positive, green = TP.</p>
<table id="perImage" border="1" style="border-collapse:collapse">
  <thead><tr>
    <th>#</th><th>Filename</th><th>Label</th><th>Blocked</th><th>Category</th>
    <th>Porn</th><th>Hentai</th><th>P+H sum</th><th>Sexy</th><th>Neutral</th><th>Drawing</th>
    <th>inferenceMs</th><th>Notes</th>
  </tr></thead>
  <tbody>
    ${tableRows(results)}
  </tbody>
</table>`;
}

function tableRows(results: ImageResult[]): string {
  const misses = results.filter(r => r.label === "explicit" && !r.blocked);
  const fps    = results.filter(r => r.label === "safe"     &&  r.blocked);
  const tps    = results.filter(r => r.label === "explicit" &&  r.blocked);
  const tns    = results.filter(r => r.label === "safe"     && !r.blocked);
  const sorted = [...misses, ...fps, ...tps, ...tns];

  return sorted.map((r, i) => {
    const rowClass = r.label === "explicit" && !r.blocked ? "miss"
                   : r.label === "safe"     &&  r.blocked ? "fp"
                   : r.label === "explicit" &&  r.blocked ? "tp"
                   : "tn";
    const notes: string[] = [];
    if (r.label === "explicit" && !r.blocked) notes.push("❌ MISS");
    if (r.label === "safe"     &&  r.blocked) notes.push("⚠️ FP");
    if (/nsfw.?04/i.test(r.filename))         notes.push("🔎 nsfw-04");
    if (/yoga|sculpture|fitness|sport/i.test(r.filename)) notes.push("hard-safe");
    return `<tr class="${rowClass}">
      <td>${i + 1}</td>
      <td>${esc(r.filename)}</td>
      <td>${r.label}</td>
      <td>${r.blocked ? "🚫 YES" : "✅ NO"}</td>
      <td>${r.category}</td>
      <td>${pct(r.Porn)}</td>
      <td>${pct(r.Hentai)}</td>
      <td><strong>${pct(r.PornHentaiSum)}</strong></td>
      <td>${pct(r.Sexy)}</td>
      <td>${pct(r.Neutral)}</td>
      <td>${pct(r.Drawing)}</td>
      <td>${r.inferenceMs}</td>
      <td>${notes.join(" ")}</td>
    </tr>`;
  }).join("");
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function ms(t: number): number { return Math.round(performance.now() - t); }
function pct(n: number): string { return (n * 100).toFixed(1) + "%"; }
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Main ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const logEl        = document.getElementById("log")         as HTMLPreElement;
  const progressEl   = document.getElementById("progress")    as HTMLDivElement;
  const runBtn       = document.getElementById("runBtn")       as HTMLButtonElement;
  const folderInput  = document.getElementById("folderInput")  as HTMLInputElement;
  const sensitivityEl = document.getElementById("sensitivity") as HTMLSelectElement;

  function log(msg: string) {
    logEl.textContent += msg + "\n";
    logEl.scrollTop = logEl.scrollHeight;
  }

  runBtn.addEventListener("click", async () => {
    if (!folderInput.files || folderInput.files.length === 0) {
      log("⚠ No folder selected. Choose a folder with explicit/ and safe/ subfolders.");
      return;
    }

    runBtn.disabled = true;
    document.getElementById("stats")!.innerHTML = "";
    logEl.textContent = "";

    try {
      if (!nsfwModel) {
        log("Initialising model (first run — cold load)…");
        await initModel(log);
        log("");
      }

      const sensitivity = sensitivityEl.value as Sensitivity;
      log(`Corpus run — sensitivity="${sensitivity}"`);
      log('First image\'s inferenceMs will be excluded from latency stats (task: "discard first inference").');
      log("Processing…\n");

      const results = await runCorpus(
        folderInput.files,
        sensitivity,
        (done, total, latest) => {
          const isMiss = latest.label === "explicit" && !latest.blocked;
          const isFP   = latest.label === "safe"     &&  latest.blocked;
          const tag    = isMiss ? " ❌MISS" : isFP ? " ⚠️FP" : "";
          progressEl.textContent =
            `${done}/${total} — ${latest.filename}: ${latest.category} blocked=${latest.blocked} (${latest.inferenceMs}ms)${tag}`;
        },
        log,
      );

      log(`Done. ${results.length} images classified.`);
      renderResults(results, sensitivity);
    } catch (err) {
      log(`ERROR: ${String(err)}`);
      console.error("[diagnostic] run failed:", err);
    } finally {
      runBtn.disabled = false;
    }
  });
});
