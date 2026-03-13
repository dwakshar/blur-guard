// src/types/messages.ts
// Shared types for all three extension contexts: popup, background, content script.

export type Sensitivity = "low" | "balanced" | "strict";

// ─── Detection event ──────────────────────────────────────────────────────────

export interface DetectionEvent {
  id: string; // unique — used as React key
  kind: "image" | "video";
  src: string; // original media URL
  domain: string; // hostname extracted from src
  confidence: number; // [0, 1] from classifier
  timestamp: number; // Date.now() at detection
}

// ─── Persisted state ──────────────────────────────────────────────────────────

export interface BlurGuardState {
  enabled: boolean;
  sensitivity: Sensitivity;
  feed: DetectionEvent[];
  stats: {
    images: number;
    videos: number;
    blocked: number;
  };
}

// ─── Message types ────────────────────────────────────────────────────────────

export type MessageType =
  // popup → background
  | "GET_STATE"
  | "SET_ENABLED"
  | "SET_SENSITIVITY"
  // content → background
  | "REPORT_DETECTION"
  // background → content (broadcast)
  | "PROTECTION_TOGGLED"
  | "SENSITIVITY_CHANGED"
  // background → popup (push update so popup stays live)
  | "STATE_UPDATED";

export interface BlurGuardMessage {
  type: MessageType;
  payload?: unknown;
}
