// src/types/messages.ts
// Shared types for all extension contexts: popup, background, content script, offscreen.
// Discriminated union on `type`. Use assertNever() in switch default branches.

export type Sensitivity = "low" | "balanced" | "strict";
export type DetectionCategory = "safe" | "suggestive" | "explicit";

// Exact class labels emitted by nsfwjs — do not widen to string.
export type NsfwClassName = "Drawing" | "Hentai" | "Neutral" | "Porn" | "Sexy";

// Raw per-class output from nsfwjs.classify(). Probabilities sum to ~1 across all classes.
export interface Prediction {
  className: NsfwClassName;
  probability: number; // 0–1
}

// SW's processed decision after mapping Predictions through sensitivity thresholds.
// Structurally identical to ClassificationResult in classifier.ts — assignable without cast,
// so finalizeResult() output can be forwarded directly in a BLUR_DECISION payload.
export interface Verdict {
  category: DetectionCategory;
  confidence: number;   // 0–1, probability of the dominant category
  shouldBlock: boolean;
  reasons: string[];
}

// ── Shared domain objects ─────────────────────────────────────────────────────

export interface DetectionEvent {
  id: string;
  kind: "image" | "video";
  src: string;
  domain: string;
  category: DetectionCategory;
  confidence: number;
  reasons: string[];
  timestamp: number;
  inferenceMs: number;  // nsfwjs.classify() GPU work only; 0 when unavailable
  queueWaitMs: number;  // time canvas sat waiting for classify() slot; 0 when unavailable
  decodeMs: number;     // fetch + blob + createImageBitmap; 0 when unavailable
  latencyMs: number;    // detected → BLUR_DECISION sent (user-perceived); 0 when unavailable
}

export interface BlurGuardState {
  enabled: boolean;
  pausedUntil: number;
  sensitivity: Sensitivity;
  feed: DetectionEvent[];
  stats: {
    images: number;
    videos: number;
    blocked: number;
  };
}

export interface DetectionReportPayload {
  kind: "image" | "video";
  src: string;
  category: DetectionCategory;
  confidence: number;
  reasons: string[];
}

// ── State-sync messages (popup ↔ background ↔ content) ───────────────────────

export interface GetStateMessage {
  type: "GET_STATE";
}

export interface ResetStatsMessage {
  type: "RESET_STATS";
}

export interface SetEnabledMessage {
  type: "SET_ENABLED";
  payload: boolean;
}

export interface SetPausedMessage {
  type: "SET_PAUSED";
}

export interface SetSensitivityMessage {
  type: "SET_SENSITIVITY";
  payload: Sensitivity;
}

export interface ReportDetectionMessage {
  type: "REPORT_DETECTION";
  payload: DetectionReportPayload;
}

export interface ProtectionToggledMessage {
  type: "PROTECTION_TOGGLED";
  payload: boolean;
}

export interface SensitivityChangedMessage {
  type: "SENSITIVITY_CHANGED";
  payload: Sensitivity;
}

export interface StateUpdatedMessage {
  type: "STATE_UPDATED";
  payload: BlurGuardState;
}

// ── Inference pipeline (content → SW → offscreen → SW → content) ─────────────

// Step 1 — content → SW: request inference for a detected media element.
export interface ClassifyRequestMessage {
  type: "CLASSIFY_REQUEST";
  payload: {
    id: string;         // UUID; correlates every leg of the round-trip
    url: string;        // resolved absolute src of the element
    kind: "image" | "video";
  };
}

// Step 2 — SW → offscreen: forwarded classify request (same payload, different type).
// Kept as a distinct type so switch handlers in SW and offscreen stay unambiguous.
export interface OffscreenClassifyMessage {
  type: "OFFSCREEN_CLASSIFY";
  payload: ClassifyRequestMessage["payload"];
}

// Step 3 — offscreen → SW: raw nsfwjs predictions + split timing.
export interface ClassifyResultMessage {
  type: "CLASSIFY_RESULT";
  payload: {
    id: string;
    predictions: Prediction[];
    decodeMs: number;     // fetch + blob + createImageBitmap
    inferenceMs: number;  // nsfwjs.classify() GPU work only
    queueWaitMs: number;  // canvas-ready → classify() started (serialisation delay)
  };
}

// Step 4 — SW → content: blur/block decision after threshold mapping.
export interface BlurDecisionMessage {
  type: "BLUR_DECISION";
  payload: {
    id: string;
    verdict: Verdict;
    decodeMs: number;     // fetch + blob + createImageBitmap
    inferenceMs: number;  // nsfwjs.classify() GPU work only
    queueWaitMs: number;  // canvas-ready → classify() started
    latencyMs: number;    // CLASSIFY_REQUEST received → BLUR_DECISION sent
  };
}

// ── Offscreen lifecycle (SW ↔ offscreen) ─────────────────────────────────────

// SW → offscreen: sent immediately after createDocument() to confirm the context is alive.
export interface OffscreenPingMessage {
  type: "OFFSCREEN_PING";
}

// offscreen → SW: model is fully loaded; context is ready to accept OFFSCREEN_CLASSIFY.
export interface OffscreenReadyMessage {
  type: "OFFSCREEN_READY";
}

// ── Master union ──────────────────────────────────────────────────────────────

export type BlurGuardMessage =
  // state sync
  | GetStateMessage
  | ResetStatsMessage
  | SetEnabledMessage
  | SetPausedMessage
  | SetSensitivityMessage
  | ReportDetectionMessage
  | ProtectionToggledMessage
  | SensitivityChangedMessage
  | StateUpdatedMessage
  // inference pipeline
  | ClassifyRequestMessage
  | OffscreenClassifyMessage
  | ClassifyResultMessage
  | BlurDecisionMessage
  // offscreen lifecycle
  | OffscreenPingMessage
  | OffscreenReadyMessage;

export type MessageType = BlurGuardMessage["type"];

// Place in the default branch of switch(message.type) to make non-exhaustion a compile error.
export function assertNever(x: never): never {
  throw new Error(`[BlurGuard] Unhandled message type: ${(x as { type: string }).type}`);
}
