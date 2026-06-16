// src/lib/sightengine.ts
// Sightengine nudity-2.1 REST API adapter — called from the offscreen doc.
//
// POST endpoint (bytes path):
//   POST https://api.sightengine.com/1.0/check.json
//   Query params: models=nudity-2.1 & api_user=<user> & api_secret=<secret>
//   Body:         multipart/form-data, field name "media", value = image bytes
//   Response (200 success):
//     { status: "success", nudity: { sexual_activity, sexual_display, erotica,
//       very_suggestive, suggestive, mildly_suggestive, none, ... } }
//
// NOTE: Multipart field name ("media") and auth query params ("api_user",
// "api_secret") are per Sightengine image-upload docs.  If the API rejects
// with a "missing media" error, re-verify at:
// https://sightengine.com/docs/reference#check-image-binary
//
// Privacy contract:
//   • Image BYTES are posted to api.sightengine.com — not the URL.
//   • The original image URL never leaves the browser.
//   • api_user + api_secret travel as query params (HTTPS, not logged in content).

import type { Sensitivity, SightengineConfig, SightengineNudity, Verdict } from "../types/messages";

export type { SightengineNudity };  // re-export for callers that need the type

const ENDPOINT = "https://api.sightengine.com/1.0/check.json";

interface SightengineSuccess {
  status: "success";
  nudity: SightengineNudity;
}

interface SightengineFailure {
  status: "failure";
  error: { type: string; message: string; code: number };
}

type SightengineResponse = SightengineSuccess | SightengineFailure;

// ── Native Sightengine sensitivity profiles ───────────────────────────────────
//
// Sightengine's nudity-2.1 fields are INDEPENDENT 0-1 probabilities — they do NOT
// sum to 1 like a softmax.  Multiple fields can be high simultaneously.  Additive
// combinations (e.g. sexual_activity + sexual_display) can exceed 1 before clamping.
//
// These thresholds must NOT be confused with NSFWJS thresholds (classifier.ts).
// NSFWJS SENSITIVITY_PROFILES were tuned for softmax output and a specific FP mode
// (fitness/sportswear inflating the Sexy class while Neutral stays mid).  That
// failure mode does not exist in Sightengine's field-level design.
//
// NSFWJS reference (from classifier.ts SENSITIVITY_PROFILES) — for contrast only:
//   ─────────────────────────────────────────────────────────────────────────────
//   sensitivity  explicitThreshold  suggestiveThreshold  suggestiveBlockThreshold
//   low          0.94               0.68                 1.00  (never blocks suggestive)
//   balanced     0.90               0.58                 0.78
//   strict       0.82               0.46                 0.65
//   ─────────────────────────────────────────────────────────────────────────────
//   Those numbers are for a Porn+Hentai combined softmax score (0–0.99).
//   The numbers below operate on independent probability fields — they are lower
//   because a 0.60 sexual_activity score already represents strong model confidence.
//
// TODO: validate against a labeled test set.  These are calibrated estimates based
// on Sightengine's published score distributions; measured FP/FN rates may shift them.

type SightengineProfile = {
  // Explicit gate — sexual_activity + sexual_display summed (independent probs, may > 1)
  explicitCombinedThreshold: number;
  // Erotica gate — artistic/stylised nudity; needs a higher gate than raw explicit
  eroticaThreshold: number;
  // Suggestive label gate — very_suggestive at this level → category "suggestive"
  verySuggestiveThreshold: number;
  // Suggestive BLOCK gate — very_suggestive must also clear this to set shouldBlock=true
  // (label and block are split so borderline scores are informational-only)
  verySuggestiveBlockThreshold: number;
  // Secondary suggestive signal — labels but never blocks alone (weaker evidence)
  suggestiveFieldThreshold: number;
  // Tertiary suggestive signal — only enabled in strict to avoid sportswear FPs
  mildlySuggestiveThreshold: number;
};

const SIGHTENGINE_PROFILES: Record<Sensitivity, SightengineProfile> = {
  // low: catch only unmistakably explicit; never block on suggestive
  low: {
    explicitCombinedThreshold:    0.80,  // vs NSFWJS: 0.94 (softmax Porn+Hentai)
    eroticaThreshold:             0.85,
    verySuggestiveThreshold:      0.80,
    verySuggestiveBlockThreshold: 1.00,  // never blocks suggestive
    suggestiveFieldThreshold:     1.00,  // disabled
    mildlySuggestiveThreshold:    1.00,  // disabled
  },
  // balanced: catch clear explicit + confidently suggestive; tolerate rare FP
  balanced: {
    explicitCombinedThreshold:    0.60,  // vs NSFWJS: 0.90
    eroticaThreshold:             0.72,
    verySuggestiveThreshold:      0.55,  // vs NSFWJS suggestiveThreshold: 0.58
    verySuggestiveBlockThreshold: 0.70,  // vs NSFWJS suggestiveBlockThreshold: 0.78
    suggestiveFieldThreshold:     0.80,
    mildlySuggestiveThreshold:    1.00,  // disabled
  },
  // strict: aggressive; accept more FP to minimise FN
  strict: {
    explicitCombinedThreshold:    0.40,  // vs NSFWJS: 0.82
    eroticaThreshold:             0.55,
    verySuggestiveThreshold:      0.40,  // vs NSFWJS suggestiveThreshold: 0.46
    verySuggestiveBlockThreshold: 0.50,  // vs NSFWJS suggestiveBlockThreshold: 0.65
    suggestiveFieldThreshold:     0.60,
    mildlySuggestiveThreshold:    0.80,
  },
};

// ── Native verdict function ───────────────────────────────────────────────────
//
// Reads Sightengine's fields directly — no collapsing into NSFWJS class names.
// Returns the same Verdict shape as verdictFromPredictions() so the SW and content
// script see a single shared contract regardless of which backend produced the score.

export function sightengineVerdictFromNudity(
  n: SightengineNudity,
  sensitivity: Sensitivity,
): Verdict {
  const p = SIGHTENGINE_PROFILES[sensitivity];

  // ── Explicit gate ─────────────────────────────────────────────────────────
  // Sum the two clearest explicit signals (may exceed 1 — clamp only the output).
  const combinedExplicit = clamp(n.sexual_activity + n.sexual_display);
  const explicitFires =
    combinedExplicit >= p.explicitCombinedThreshold ||
    n.erotica >= p.eroticaThreshold;

  if (explicitFires) {
    const confidence = clamp(Math.max(combinedExplicit, n.erotica));
    const reasons: string[] = [];
    if (n.sexual_activity >= 0.15) reasons.push("sexual_activity");
    if (n.sexual_display  >= 0.15) reasons.push("sexual_display");
    if (n.erotica >= p.eroticaThreshold) reasons.push("erotica");
    return { category: "explicit", confidence, shouldBlock: true, reasons };
  }

  // ── Suggestive gate ───────────────────────────────────────────────────────
  // Check fields in descending severity order; stop at first match.
  const suggestiveReasons: string[] = [];
  let suggestiveConfidence = 0;

  if (n.very_suggestive >= p.verySuggestiveThreshold) {
    suggestiveReasons.push("very_suggestive");
    suggestiveConfidence = n.very_suggestive;
  } else if (n.suggestive >= p.suggestiveFieldThreshold) {
    suggestiveReasons.push("suggestive");
    suggestiveConfidence = n.suggestive * 0.85; // softer signal → downweight confidence
  } else if (n.mildly_suggestive >= p.mildlySuggestiveThreshold) {
    suggestiveReasons.push("mildly_suggestive");
    suggestiveConfidence = n.mildly_suggestive * 0.65;
  }

  if (suggestiveReasons.length > 0) {
    const confidence = clamp(suggestiveConfidence);
    // Block only when very_suggestive clears the (higher) block threshold.
    // The suggestive field and mildly_suggestive are informational only.
    const shouldBlock = n.very_suggestive >= p.verySuggestiveBlockThreshold;
    return { category: "suggestive", confidence, shouldBlock, reasons: suggestiveReasons };
  }

  // ── Safe ──────────────────────────────────────────────────────────────────
  // Report the residual risk score so borderline near-misses are visible in logs.
  const safeConfidence = clamp(
    Math.max(combinedExplicit * 0.7, n.erotica * 0.7, n.very_suggestive * 0.5)
  );
  return { category: "safe", confidence: safeConfidence, shouldBlock: false, reasons: [] };
}

// ── HTTP call ─────────────────────────────────────────────────────────────────
//
// Called from the offscreen doc after the image was fetched as extension origin.
// Returns a pre-computed Verdict (not raw predictions) so the SW applies no further
// NSFWJS-tuned thresholds.

export async function sightengineClassifyBlob(
  blob: Blob,
  config: SightengineConfig,
  sensitivity: Sensitivity,
): Promise<{ verdict: Verdict; nudity: SightengineNudity; inferenceMs: number }> {
  const params = new URLSearchParams({
    models:     "nudity-2.1",
    api_user:   config.apiUser,
    api_secret: config.apiSecret,
  });

  const form = new FormData();
  form.append("media", blob, "image"); // field name per Sightengine binary-upload docs

  const t0 = performance.now();
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
    method: "POST",
    body:   form,
    signal: AbortSignal.timeout(15_000),
  });
  const inferenceMs = Math.round(performance.now() - t0);

  if (!res.ok) {
    throw new Error(`[BlurGuard Sightengine] HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as SightengineResponse;
  if (json.status !== "success") {
    const msg = json.error?.message ?? "unknown error";
    throw new Error(`[BlurGuard Sightengine] API error: ${msg}`);
  }

  const verdict = sightengineVerdictFromNudity(json.nudity, sensitivity);
  return { verdict, nudity: json.nudity, inferenceMs };
}

function clamp(v: number): number {
  return Math.max(0, Math.min(0.99, v));
}
