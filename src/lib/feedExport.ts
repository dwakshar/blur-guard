// src/lib/feedExport.ts
// Feed export helpers: JSON and CSV download from the popup.

import type { DetectionEvent } from "../types/messages";

function hashUrl(url: string): string {
  // FNV-1a 32-bit: fast, synchronous, good enough for a stable per-URL identifier.
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function toRow(e: DetectionEvent) {
  return {
    urlHash: hashUrl(e.src),
    verdict: e.category,
    confidence: e.confidence,
    backend: e.backend,
    inferenceMs: e.inferenceMs,
    queueWaitMs: e.queueWaitMs,
    decodeMs: e.decodeMs,
    latencyMs: e.latencyMs,
    timestamp: e.timestamp,
    kind: e.kind,
    domain: e.domain,
    cloudCheckFailed: e.cloudCheckFailed ?? false,
  };
}

function triggerDownload(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportFeedAsJson(feed: DetectionEvent[]): void {
  triggerDownload(
    JSON.stringify(feed.map(toRow), null, 2),
    "blurguard-feed.json",
    "application/json",
  );
}

const CSV_HEADERS = [
  "urlHash", "verdict", "confidence", "backend",
  "inferenceMs", "queueWaitMs", "decodeMs", "latencyMs",
  "timestamp", "kind", "domain", "cloudCheckFailed",
] as const;

export function exportFeedAsCsv(feed: DetectionEvent[]): void {
  const lines = [
    CSV_HEADERS.join(","),
    ...feed.map((e) => {
      const r = toRow(e);
      return CSV_HEADERS.map((k) => {
        const v = r[k];
        return typeof v === "string" && v.includes(",") ? `"${v}"` : String(v);
      }).join(",");
    }),
  ];
  triggerDownload(lines.join("\n"), "blurguard-feed.csv", "text/csv");
}
