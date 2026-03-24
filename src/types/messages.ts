// src/types/messages.ts
// Shared types for all three extension contexts: popup, background, content script.

export type Sensitivity = "low" | "balanced" | "strict";
export type DetectionCategory = "safe" | "suggestive" | "explicit";

export interface DetectionEvent {
  id: string;
  kind: "image" | "video";
  src: string;
  domain: string;
  category: DetectionCategory;
  confidence: number;
  reasons: string[];
  timestamp: number;
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

export type BlurGuardMessage =
  | GetStateMessage
  | ResetStatsMessage
  | SetEnabledMessage
  | SetPausedMessage
  | SetSensitivityMessage
  | ReportDetectionMessage
  | ProtectionToggledMessage
  | SensitivityChangedMessage
  | StateUpdatedMessage;

export type MessageType = BlurGuardMessage["type"];
