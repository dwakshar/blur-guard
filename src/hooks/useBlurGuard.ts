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
  BlurGuardMessage,
  BlurGuardState,
  Sensitivity,
} from "../types/messages";

// ─── Dev/preview fallback (Vite dev server, no chrome API) ───────────────────

const DEV_STATE: BlurGuardState = {
  enabled: true,
  sensitivity: "balanced",
  stats: { images: 847, videos: 123, blocked: 34 },
  feed: [
    {
      id: "1",
      kind: "image",
      src: "https://reddit.com/nsfw-img.jpg",
      domain: "reddit.com",
      confidence: 0.97,
      timestamp: Date.now() - 120_000,
    },
    {
      id: "2",
      kind: "video",
      src: "https://unknown-site.xyz/vid.mp4",
      domain: "unknown-site.xyz",
      confidence: 0.91,
      timestamp: Date.now() - 480_000,
    },
    {
      id: "3",
      kind: "image",
      src: "https://imgur.com/maybe-nsfw.jpg",
      domain: "imgur.com",
      confidence: 0.65,
      timestamp: Date.now() - 840_000,
    },
    {
      id: "4",
      kind: "image",
      src: "https://twitter.com/thumb-suspicious",
      domain: "twitter.com",
      confidence: 0.38,
      timestamp: Date.now() - 1_860_000,
    },
  ],
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
  const [state, setState] = useState<BlurGuardState>(DEV_STATE);
  const [loading, setLoading] = useState(true);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    sendMessage({ type: "GET_STATE" }).then((response) => {
      if (response) setState(response as BlurGuardState);
      setLoading(false);
    });
  }, []);

  // ── Live push from background ─────────────────────────────────────────────
  // The background calls chrome.runtime.sendMessage({ type: 'STATE_UPDATED' })
  // whenever state changes. The popup window receives it here and re-renders.
  useEffect(() => {
    if (!isExtension) return;

    const listener = (message: BlurGuardMessage) => {
      if (message.type === "STATE_UPDATED" && message.payload) {
        setState(message.payload as BlurGuardState);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const setEnabled = useCallback(async (enabled: boolean) => {
    // Optimistic update so toggle feels instant
    setState((prev) => ({ ...prev, enabled }));
    await sendMessage({ type: "SET_ENABLED", payload: enabled });
  }, []);

  const setSensitivity = useCallback(async (sensitivity: Sensitivity) => {
    setState((prev) => ({ ...prev, sensitivity }));
    await sendMessage({ type: "SET_SENSITIVITY", payload: sensitivity });
  }, []);

  return { state, loading, setEnabled, setSensitivity };
}
