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
import { CLOUD_BACKEND_ENABLED } from "../lib/featureFlags";

// ─── Dev/preview fallback (Vite dev server, no chrome API) ───────────────────

const EMPTY_STATE: BlurGuardState = {
  enabled: true,
  pausedUntil: 0,
  sensitivity: "balanced",
  apiBackend: "tfjs",
  stats: { images: 0, videos: 0, blocked: 0, cloudErrors: 0 },
  cloudWarning: null,
  allowlist: [],
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
  const [activeDomain, setActiveDomain] = useState<string | null>(null);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    sendMessage({ type: "GET_STATE" }).then((response) => {
      if (response) {
        const r = response as BlurGuardState;
        setState({
          ...EMPTY_STATE,
          ...r,
          stats: { ...EMPTY_STATE.stats, ...(r.stats ?? {}) },
          allowlist: Array.isArray(r.allowlist) ? r.allowlist : [],
        });
      }
      setLoading(false);
    });

    // Load Sightengine credentials from storage (separate key, never broadcast).
    // Gated on CLOUD_BACKEND_ENABLED so the key and credential property names are
    // dead code in the v1 build — Rollup eliminates this entire block when false.
    if (isExtension && CLOUD_BACKEND_ENABLED) {
      chrome.storage.local.get("blurguard_sightengine").then((data) => {
        const cfg = data.blurguard_sightengine as Partial<SightengineConfig> | undefined;
        if (cfg?.apiUser && cfg?.apiSecret) {
          setApiConfigState({ apiUser: cfg.apiUser, apiSecret: cfg.apiSecret });
        }
      });

      // Resolve the active tab's hostname for the "Disable on this site" toggle.
      chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        const url = tabs[0]?.url;
        if (!url) return;
        try {
          const { hostname } = new URL(url);
          if (hostname) setActiveDomain(hostname);
        } catch {
          // Restricted scheme (chrome://, about:, etc.) — leave activeDomain null.
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

  const addAllowlistDomain = useCallback(async (domain: string) => {
    setState((prev) => ({
      ...prev,
      allowlist: prev.allowlist.includes(domain) ? prev.allowlist : [...prev.allowlist, domain],
    }));
    await sendMessage({ type: "ADD_ALLOWLIST_DOMAIN", payload: domain });
  }, []);

  const removeAllowlistDomain = useCallback(async (domain: string) => {
    setState((prev) => ({
      ...prev,
      allowlist: prev.allowlist.filter((d) => d !== domain),
    }));
    await sendMessage({ type: "REMOVE_ALLOWLIST_DOMAIN", payload: domain });
  }, []);

  return {
    state, loading, activeDomain,
    setEnabled, setPaused, resetStats, setSensitivity,
    setApiBackend, setApiConfig, apiConfig,
    addAllowlistDomain, removeAllowlistDomain,
  };
}
