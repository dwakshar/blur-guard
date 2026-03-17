// src/lib/classifier.ts
// Shared classifier abstraction for popup/content/background consumers.

import type * as TfjsModule from "@tensorflow/tfjs";
import type { Sensitivity } from "../types/messages";

export interface ClassificationResult {
  explicit: boolean;
  confidence: number;
}

export type ClassifierBackend = "pattern" | "api" | "tfjs";

export interface ClassifierOptions {
  backend: ClassifierBackend;
  sensitivity: Sensitivity;
  apiConfig?: ApiBackendConfig;
  tfjsConfig?: TfjsBackendConfig;
}

export interface ApiBackendConfig {
  endpoint: string;
  apiKey?: string;
  responsePath?: string;
}

export interface TfjsBackendConfig {
  modelUrl: string;
  imageSize?: number;
}

export interface Classifier {
  classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult>;
  dispose(): void;
}

type NsfwPrediction = {
  className: string;
  probability: number;
};

const THRESHOLD: Record<Sensitivity, number> = {
  low: 0.85,
  balanced: 0.6,
  strict: 0.35,
};

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

const NSFW_WEIGHTS: Record<string, number> = {
  Porn: 1.0,
  Hentai: 1.0,
  Sexy: 0.6,
  Neutral: 0.0,
  Drawing: 0.0,
};

type TfRuntime = typeof TfjsModule;
type TfLayersModel = TfjsModule.LayersModel;
type TfTensor3D = TfjsModule.Tensor3D;
type TfTensor = TfjsModule.Tensor;

const NSFW_CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"] as const;

let runtimePromise: Promise<TfRuntime> | null = null;

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
  }
}

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

    const matched = PATTERN_SETS[this.sensitivity].filter((re) => re.test(src));
    if (matched.length === 0) return miss();

    return hit(0.7 + matched.length * 0.08);
  }

  dispose(): void {}
}

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
        headers.Authorization = `Bearer ${this.config.apiKey}`;
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
      const result: ClassificationResult = {
        explicit: confidence >= THRESHOLD[this.sensitivity],
        confidence,
      };

      this.cache.set(src, result);
      return result;
    } catch (error) {
      console.warn("[BlurGuard] API classify error:", error);
      return miss();
    }
  }

  dispose(): void {
    this.cache.clear();
  }
}

class TfjsClassifier implements Classifier {
  private model: TfLayersModel | null = null;
  private loading: Promise<TfLayersModel> | null = null;
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
      const tf = await getTfRuntime();
      const model = await this.loadModel();
      const target =
        el instanceof HTMLVideoElement ? captureVideoFrame(el) : el;
      if (!target) return miss();

      const predictions = await classifyWithModel(
        tf,
        model,
        target,
        this.config.imageSize ?? 224
      );

      let weightedSum = 0;
      let totalWeight = 0;

      for (const prediction of predictions) {
        const weight = NSFW_WEIGHTS[prediction.className] ?? 0;
        weightedSum += prediction.probability * weight;
        totalWeight += weight;
      }

      const confidence =
        totalWeight > 0 ? clampConfidence(weightedSum / totalWeight) : 0;

      return {
        explicit: confidence >= THRESHOLD[this.sensitivity],
        confidence,
      };
    } catch (error) {
      console.warn("[BlurGuard] TFJS classify error:", error);
      return miss();
    }
  }

  dispose(): void {
    this.model = null;
    this.loading = null;
  }

  private loadModel(): Promise<TfLayersModel> {
    if (this.model) return Promise.resolve(this.model);

    if (!this.loading) {
      this.loading = (async () => {
        const tf = await getTfRuntime();
        await tf.ready();
        const modelUrl = normalizeModelUrl(this.config.modelUrl);
        const model = await tf.loadLayersModel(modelUrl);
        this.model = model;
        return model;
      })();
    }

    return this.loading;
  }
}

async function getTfRuntime(): Promise<TfRuntime> {
  if (!runtimePromise) {
    runtimePromise = import("@tensorflow/tfjs");
  }

  return runtimePromise;
}

async function classifyWithModel(
  tf: TfRuntime,
  model: TfLayersModel,
  el: HTMLImageElement | HTMLCanvasElement,
  imageSize: number
): Promise<NsfwPrediction[]> {
  const pixels = tf.browser.fromPixels(el) as TfTensor3D;
  const normalized = pixels.toFloat() as TfTensor3D;
  const resized: TfTensor3D =
    pixels.shape[0] === imageSize && pixels.shape[1] === imageSize
        ? normalized
      : (tf.image.resizeBilinear(
          normalized,
          [imageSize, imageSize],
          true
        ) as TfTensor3D);
  const batched = resized.reshape([1, imageSize, imageSize, 3]);
  const prediction = model.predict(batched);
  const scoresTensor = (Array.isArray(prediction)
    ? prediction[0]
    : prediction) as TfTensor | null;

  if (!scoresTensor || !("data" in scoresTensor)) {
    pixels.dispose();
    normalized.dispose();
    if (resized !== normalized) {
      resized.dispose();
    }
    batched.dispose();
    throw new Error("[BlurGuard] TFJS model returned no scores");
  }

  const probabilities = Array.from(await scoresTensor.data());

  pixels.dispose();
  normalized.dispose();
  if (resized !== normalized) {
    resized.dispose();
  }
  batched.dispose();
  scoresTensor.dispose();

  return probabilities
    .map((probability, index) => ({
      className: NSFW_CLASSES[index] ?? `Class-${index}`,
      probability,
    }))
    .sort((a, b) => b.probability - a.probability);
}

function normalizeModelUrl(modelUrl: string): string {
  return modelUrl.endsWith("model.json") ? modelUrl : `${modelUrl}model.json`;
}

function resolveSrc(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }

  return el.currentSrc || el.src || el.querySelector("source")?.src || "";
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.99)) : 0;
}

function hit(confidence: number): ClassificationResult {
  return { explicit: true, confidence: clampConfidence(confidence) };
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

  return clampConfidence(Number(cursor));
}

function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d")?.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
  return canvas;
}
