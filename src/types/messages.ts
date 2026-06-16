// src/types/messages.ts
// Shared types for all extension contexts: popup, background, content script, offscreen.
// Discriminated union on `type`. Use assertNever() in switch default branches.

export type Sensitivity = "low" | "balanced" | "strict";
export type DetectionCategory = "safe" | "suggestive" | "explicit";
// Note: cloud API failures are NOT a DetectionCategory — they are flagged via
// DetectionEvent.cloudCheckFailed so the category field always describes content,
// not infrastructure state.
export type ApiBackend = "tfjs" | "sightengine";

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

// Credentials for the Sightengine API backend.
// Stored under a separate chrome.storage key ("blurguard_sightengine") so they
// are never included in STATE_UPDATED broadcasts that reach content scripts.
export interface SightengineConfig {
  apiUser: string;
  apiSecret: string;
}

// Raw Sightengine nudity-2.1 field scores.
// Each field is an independent 0-1 probability — they do NOT sum to 1.
// Stored in the verdict cache so the SW can re-derive a Verdict with any
// sensitivity setting without a new API call.
export interface SightengineNudity {
  sexual_activity: number;
  sexual_display: number;
  erotica: number;
  very_suggestive: number;
  suggestive: number;
  mildly_suggestive: number;
  none: number;
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
  backend: ApiBackend;
  inferenceMs: number;  // nsfwjs.classify() GPU work only; 0 when unavailable
  queueWaitMs: number;  // time canvas sat waiting for classify() slot; 0 when unavailable
  decodeMs: number;     // fetch + blob + createImageBitmap; 0 when unavailable
  latencyMs: number;    // detected → BLUR_DECISION sent (user-perceived); 0 when unavailable
  // Cloud API failure flags (only set when backend === "sightengine" and the call failed).
  // category stays "safe" and shouldBlock stays false (fail-open policy).
  cloudCheckFailed?: boolean;   // true → the API call failed, not a content decision
  cloudErrorReason?: string;    // truncated error detail for feed display
}

export interface BlurGuardState {
  enabled: boolean;
  pausedUntil: number;
  sensitivity: Sensitivity;
  apiBackend: ApiBackend; // "tfjs" = on-device (default); "sightengine" = cloud API
  feed: DetectionEvent[];
  stats: {
    images: number;
    videos: number;
    blocked: number;
    cloudErrors: number; // cloud API call failures (not blocked — fail-open)
  };
  // Non-null when repeated cloud failures need user attention.
  // Set by the SW after CLOUD_FAILURE_WARNING_THRESHOLD consecutive failures;
  // cleared on next successful cloud check or on RESET_STATS.
  cloudWarning: string | null;
  // Domains where the content script should not scan at all.
  // Stored as lowercase hostnames (e.g. "example.com").
  allowlist: string[];
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

export interface SetApiBackendMessage {
  type: "SET_API_BACKEND";
  payload: ApiBackend;
}

// Credentials sent once when the user saves them. Stored separately from
// BlurGuardState so they never appear in STATE_UPDATED broadcasts.
export interface SetApiConfigMessage {
  type: "SET_API_CONFIG";
  payload: SightengineConfig;
}

export interface ReportDetectionMessage {
  type: "REPORT_DETECTION";
  payload: DetectionReportPayload;
}

export interface AddAllowlistDomainMessage {
  type: "ADD_ALLOWLIST_DOMAIN";
  payload: string; // lowercase hostname to allowlist
}

export interface RemoveAllowlistDomainMessage {
  type: "REMOVE_ALLOWLIST_DOMAIN";
  payload: string; // lowercase hostname to remove
}

// SW → all content scripts: pushed whenever the allowlist changes.
// Content scripts use this to start/stop scanning without a full state reload.
export interface AllowlistUpdatedMessage {
  type: "ALLOWLIST_UPDATED";
  payload: string[]; // full current allowlist
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
    id: string;               // UUID; correlates every leg of the round-trip
    url: string;              // resolved absolute src of the element
    kind: "image" | "video";
    priority: "high" | "low"; // high = in/near viewport; low = off-screen
  };
}

// Content → SW: promote a pending request to the front of the SW queue.
// Sent when an observed element scrolls into the viewport before classify completes.
export interface ClassifyPrioritizeMessage {
  type: "CLASSIFY_PRIORITIZE";
  payload: { id: string };
}

// Content → SW: remove a pending request from the SW queue.
// Sent when an element is removed from DOM before classify completes.
export interface ClassifyCancelMessage {
  type: "CLASSIFY_CANCEL";
  payload: { id: string };
}

// Step 2 — SW → offscreen: forwarded classify request.
// Extends ClassifyRequest with backend, sensitivity (needed by sightengine native
// verdict fn), and per-request credentials.  Credentials are in-flight only —
// never in STATE_UPDATED or any content-script message.
export interface OffscreenClassifyMessage {
  type: "OFFSCREEN_CLASSIFY";
  payload: {
    id: string;
    url: string;
    kind: "image" | "video";
    backend: "tfjs" | "sightengine";
    sensitivity: Sensitivity;
    sightengineConfig?: SightengineConfig; // only when backend === "sightengine"
  };
}

// Step 3 — offscreen → SW: classify result.
// Exactly one of predictions / verdict / cloudError is set:
//   tfjs:        predictions — SW maps through verdictFromPredictions (NSFWJS thresholds)
//   sightengine: verdict    — native thresholds, computed in offscreen
//   sightengine: cloudError — API call failed; SW records failure in feed (fail-open)
// nudity is set alongside verdict on sightengine success so the SW can cache the
// raw field scores and re-derive verdicts under any future sensitivity setting.
export interface ClassifyResultMessage {
  type: "CLASSIFY_RESULT";
  payload: {
    id: string;
    predictions?: Prediction[];    // tfjs only
    verdict?: Verdict;             // sightengine success only
    nudity?: SightengineNudity;    // sightengine raw scores — for SW-side cache only
    cloudError?: string;           // sightengine failure: raw error reason (not a verdict)
    decodeMs: number;
    inferenceMs: number;
    queueWaitMs: number;
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
  | SetApiBackendMessage
  | SetApiConfigMessage
  | ReportDetectionMessage
  | AddAllowlistDomainMessage
  | RemoveAllowlistDomainMessage
  | ProtectionToggledMessage
  | SensitivityChangedMessage
  | AllowlistUpdatedMessage
  | StateUpdatedMessage
  // inference pipeline
  | ClassifyRequestMessage
  | ClassifyPrioritizeMessage
  | ClassifyCancelMessage
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
