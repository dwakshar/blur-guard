// src/lib/classifier.ts
//
// Abstraction layer for media classification.
// Supports three backend strategies, selected at runtime:
//
//   'pattern'   — zero-latency heuristic (URL/filename regex). Default fallback.
//   'api'       — delegates to an external HTTP moderation endpoint.
//   'tfjs'      — runs a local TensorFlow.js NSFW detection model in-browser.
//
// All backends return the same ClassificationResult shape so callers never
// need to know which strategy is active.

import type { Sensitivity } from "../types/messages";

// ─── Public contract ──────────────────────────────────────────────────────────

export interface ClassificationResult {
  /** Whether the media should be treated as explicit */
  explicit: boolean;
  /** Probability in [0, 1]. Higher = more likely explicit. */
  confidence: number;
}

export type ClassifierBackend = "pattern" | "api" | "tfjs";

export interface ClassifierOptions {
  backend: ClassifierBackend;
  sensitivity: Sensitivity;

  /** Required when backend === 'api' */
  apiConfig?: ApiBackendConfig;

  /** Required when backend === 'tfjs' */
  tfjsConfig?: TfjsBackendConfig;
}

export interface ApiBackendConfig {
  /** Full URL of the moderation endpoint. POST with { imageUrl: string } */
  endpoint: string;
  /** Bearer token or API key forwarded in Authorization header */
  apiKey?: string;
  /**
   * Optional: path into the JSON response that contains the adult probability.
   * E.g. 'result.adult' or 'scores.explicit'. Defaults to 'confidence'.
   */
  responsePath?: string;
}

export interface TfjsBackendConfig {
  /**
   * URL of the NSFW.js model directory (e.g. from a CDN or chrome.runtime.getURL).
   * The classifier will dynamically import @tensorflow/tfjs and nsfwjs.
   * Example: chrome.runtime.getURL('models/nsfwjs/')
   */
  modelUrl: string;
  /**
   * Image size passed to model.classify(). Defaults to 224.
   * Must match the size the model was trained at.
   */
  imageSize?: number;
}

/** Classifier instance returned by createClassifier() */
export interface Classifier {
  /**
   * Classify a media element.
   * For <video>, uses the current frame (captured via canvas).
   * Returns a zeroed result on error rather than throwing.
   */
  classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult>;

  /** Free any held resources (TF models, etc.) */
  dispose(): void;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createClassifier(options: ClassifierOptions): Classifier {
  switch (options.backend) {
    case "pattern":
      return new PatternClassifier(options.sensitivity);

    case "api":
      if (!options.apiConfig) {
        throw new Error('[BlurGuard] backend="api" requires apiConfig');
      }
      return new ApiClassifier(options.apiConfig, options.sensitivity);

    case "tfjs":
      if (!options.tfjsConfig) {
        throw new Error('[BlurGuard] backend="tfjs" requires tfjsConfig');
      }
      return new TfjsClassifier(options.tfjsConfig, options.sensitivity);

    default:
      throw new Error(
        `[BlurGuard] Unknown classifier backend: ${String(options.backend)}`
      );
  }
}

// ─── Shared threshold helper ──────────────────────────────────────────────────

const THRESHOLD: Record<Sensitivity, number> = {
  low: 0.85,
  balanced: 0.6,
  strict: 0.35,
};

// ─── Backend 1: Pattern (URL heuristic) ──────────────────────────────────────

const PATTERN_SETS: Record<Sensitivity, RegExp[]> = {
  low: [/\bnsfw\b/i, /\badult\b/i, /\bxxx\b/i, /\bporn/i],
  balanced: [
    /\bnsfw\b/i,
    /\badult\b/i,
    /\bxxx\b/i,
    /\bporn/i,
    /\bexplicit\b/i,
    /\bnude\b/i,
    /\bhentai\b/i,
  ],
  strict: [
    /\bnsfw\b/i,
    /\badult\b/i,
    /\bxxx\b/i,
    /\bporn/i,
    /\bexplicit\b/i,
    /\bnude\b/i,
    /\bhentai\b/i,
    /\bsexy\b/i,
    /\blewd\b/i,
    /\berotic\b/i,
  ],
};

class PatternClassifier implements Classifier {
  private sensitivity: Sensitivity;

  constructor(sensitivity: Sensitivity) {
    this.sensitivity = sensitivity;
  }

  async classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult> {
    const src = resolveSrc(el);
    if (!src) return miss();

    const patterns = PATTERN_SETS[this.sensitivity];
    const matched = patterns.filter((re) => re.test(src));

    if (matched.length === 0) return miss();

    const raw = Math.min(0.97, 0.7 + matched.length * 0.08);
    return hit(raw);
  }

  dispose(): void {
    /* nothing to free */
  }
}

// ─── Backend 2: External Moderation API ──────────────────────────────────────

class ApiClassifier implements Classifier {
  private cache = new Map<string, ClassificationResult>();
  private config: ApiBackendConfig;
  private sensitivity: Sensitivity;

  constructor(config: ApiBackendConfig, sensitivity: Sensitivity) {
    this.config = config;
    this.sensitivity = sensitivity;
  }

  async classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult> {
    const src = resolveSrc(el);
    if (!src) return miss();

    if (this.cache.has(src)) return this.cache.get(src)!;

    try {
      const headers: HeadersInit = { "Content-Type": "application/json" };
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ imageUrl: src }),
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        console.warn(`[BlurGuard] API returned ${response.status} for ${src}`);
        return miss();
      }

      const json: unknown = await response.json();
      const confidence = extractConfidence(
        json,
        this.config.responsePath ?? "confidence"
      );
      const threshold = THRESHOLD[this.sensitivity];
      const result: ClassificationResult = {
        explicit: confidence >= threshold,
        confidence,
      };

      this.cache.set(src, result);
      return result;
    } catch (err) {
      console.warn("[BlurGuard] API classify error:", err);
      return miss();
    }
  }

  dispose(): void {
    this.cache.clear();
  }
}

// ─── Backend 3: TensorFlow.js (NSFW.js) ──────────────────────────────────────

const NSFW_WEIGHTS: Record<string, number> = {
  Porn: 1.0,
  Hentai: 1.0,
  Sexy: 0.6,
  Neutral: 0.0,
  Drawing: 0.0,
};

type NsfwModel = {
  classify(
    el: HTMLImageElement | HTMLCanvasElement,
    size?: number
  ): Promise<Array<{ className: string; probability: number }>>;
};

class TfjsClassifier implements Classifier {
  private model: NsfwModel | null = null;
  private loading: Promise<NsfwModel> | null = null;
  private config: TfjsBackendConfig;
  private sensitivity: Sensitivity;

  constructor(config: TfjsBackendConfig, sensitivity: Sensitivity) {
    this.config = config;
    this.sensitivity = sensitivity;
  }

  async classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult> {
    try {
      const model = await this.loadModel();
      const target =
        el instanceof HTMLVideoElement ? captureVideoFrame(el) : el;
      if (!target) return miss();

      const size = this.config.imageSize ?? 224;
      const predictions = await model.classify(target, size);

      let weightedSum = 0;
      let totalWeight = 0;
      for (const { className, probability } of predictions) {
        const w = NSFW_WEIGHTS[className] ?? 0;
        weightedSum += probability * w;
        totalWeight += w;
      }

      const confidence = totalWeight > 0 ? weightedSum / totalWeight : 0;
      const threshold = THRESHOLD[this.sensitivity];

      return { explicit: confidence >= threshold, confidence };
    } catch (err) {
      console.warn("[BlurGuard] TFJS classify error:", err);
      return miss();
    }
  }

  dispose(): void {
    this.model = null;
    this.loading = null;
  }

  private loadModel(): Promise<NsfwModel> {
    if (this.model) return Promise.resolve(this.model);

    if (!this.loading) {
      this.loading = (async () => {
        const [, nsfwjs] = await Promise.all([
          import("@tensorflow/tfjs" as string),
          import("nsfwjs" as string),
        ]);

        const model = await (
          nsfwjs as { load: (url: string) => Promise<NsfwModel> }
        ).load(this.config.modelUrl);
        this.model = model;
        return model;
      })();
    }

    return this.loading;
  }
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function resolveSrc(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }
  if (el.src) return el.src;
  return el.querySelector("source")?.src || "";
}

function hit(confidence: number): ClassificationResult {
  return { explicit: true, confidence };
}

function miss(): ClassificationResult {
  return { explicit: false, confidence: 0 };
}

function extractConfidence(json: unknown, path: string): number {
  const parts = path.split(".");

  let cursor: unknown = json;

  for (const part of parts) {
    if (cursor == null || typeof cursor !== "object") {
      return 0;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  const value = Number(cursor);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  const { videoWidth: w, videoHeight: h } = video;
  if (w === 0 || h === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(video, 0, 0, w, h);
  return canvas;
}
