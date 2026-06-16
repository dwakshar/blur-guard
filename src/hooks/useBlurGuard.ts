// src/hooks/useBlurGuard.ts
// Connects the popup React UI to the background service worker.
//
// On mount:   sends GET_STATE → background returns full BlurGuardState
// Live sync:  listens for STATE_UPDATED messages pushed by the background
//             whenever a detection happens or settings change in another context
// Actions:    setEnabled / setSensitivity send messages and optimistically
//             update local state so the UI feels instant

import { useCallback, useEffect, useState } from "react";
import type {
  ApiBackend,
  BlurGuardMessage,
  BlurGuardState,
  Sensitivity,
  SightengineConfig,
} from "../types/messages";

// ─── Dev/preview fallback (Vite dev server, no chrome API) ───────────────────

const EMPTY_STATE: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  apiBackend: "tfjs",
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  feed: [],
};

// ─── Chrome API wrapper (degrades gracefully outside extension) ───────────────

const isExtension =
  typeof chrome !== "undefined" && chrome.runtime?.sendMessage != null;

function sendMessage(message: BlurGuardMessage): Promise<unknown> {
  if (!isExtension) return Promise.resolve(null);
  return chrome.runtime.sendMessage(message).catch(() => null);
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useBlurGuard() {
  const [state, setState] = useState<BlurGuardState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [apiConfig, setApiConfigState] = useState<SightengineConfig | null>(null);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    sendMessage({ type: "GET_STATE" }).then((response) => {
      if (response) {
        const r = response as BlurGuardState;
        setState({ ...EMPTY_STATE, ...r, stats: { ...EMPTY_STATE.stats, ...(r.stats ?? {}) } });
      }
      setLoading(false);
    });

    // Load Sightengine credentials from storage (separate key, never broadcast).
    if (isExtension) {
      chrome.storage.local.get("blurguard_sightengine").then((data) => {
        const cfg = data.blurguard_sightengine as Partial<SightengineConfig> | undefined;
        if (cfg?.apiUser && cfg?.apiSecret) {
          setApiConfigState({ apiUser: cfg.apiUser, apiSecret: cfg.apiSecret });
        }
      });
    }
  }, []);

  // ── Live push from background ─────────────────────────────────────────────
  // The background calls chrome.runtime.sendMessage({ type: 'STATE_UPDATED' })
  // whenever state changes. The popup window receives it here and re-renders.
  useEffect(() => {
    if (!isExtension) return;

    const listener = (message: BlurGuardMessage) => {
      if (message.type === "STATE_UPDATED" && message.payload) {
        const p = message.payload as BlurGuardState;
        setState(prev => ({ ...prev, ...p, stats: { ...prev.stats, ...(p.stats ?? {}) } }));
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const setEnabled = useCallback(async (enabled: boolean) => {
    // Optimistic update so toggle feels instant
    setState((prev) => ({ ...prev, enabled, pausedUntil: enabled ? 0 : prev.pausedUntil }));
    await sendMessage({ type: "SET_ENABLED", payload: enabled });
  }, []);

  const setPaused = useCallback(async () => {
    const pausedUntil = Date.now() + 5 * 60 * 1000;
    setState((prev) => ({ ...prev, enabled: false, pausedUntil }));
    await sendMessage({ type: "SET_PAUSED" });
  }, []);

  const resetStats = useCallback(async () => {
    setState((prev) => ({
      ...prev,
      feed: [],
      stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
      cloudWarning: null,
    }));
    await sendMessage({ type: "RESET_STATS" });
  }, []);

  const setSensitivity = useCallback(async (sensitivity: Sensitivity) => {
    setState((prev) => ({ ...prev, sensitivity }));
    await sendMessage({ type: "SET_SENSITIVITY", payload: sensitivity });
  }, []);

  const setApiBackend = useCallback(async (apiBackend: ApiBackend) => {
    setState((prev) => ({ ...prev, apiBackend }));
    await sendMessage({ type: "SET_API_BACKEND", payload: apiBackend });
  }, []);

  const setApiConfig = useCallback(async (config: SightengineConfig) => {
    setApiConfigState(config);
    await sendMessage({ type: "SET_API_CONFIG", payload: config });
  }, []);

  return { state, loading, setEnabled, setPaused, resetStats, setSensitivity, setApiBackend, setApiConfig, apiConfig };
}
