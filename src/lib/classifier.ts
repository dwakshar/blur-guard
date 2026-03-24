// src/lib/classifier.ts
// Shared classifier abstraction for popup/content/background consumers.

import type { DetectionCategory, Sensitivity } from "../types/messages";

export interface ClassificationResult {
  category: DetectionCategory;
  confidence: number;
  shouldBlock: boolean;
  reasons: string[];
}

export type ClassifierBackend = "pattern" | "api";

export interface ClassifierOptions {
  backend: ClassifierBackend;
  sensitivity: Sensitivity;
  apiConfig?: ApiBackendConfig;
}

export interface ApiBackendConfig {
  endpoint: string;
  apiKey?: string;
  responsePath?: string;
}

export interface Classifier {
  classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult>;
  dispose(): void;
}

type WeightedPattern = {
  pattern: RegExp;
  score: number;
  reason: string;
};

type HeuristicHit = {
  score: number;
  reason: string;
};

type RiskMemory = {
  suggestive: number;
  explicit: number;
};

type SensitivityProfile = {
  explicitThreshold: number;
  suggestiveThreshold: number;
  suggestiveBlockThreshold: number;
  explicitPenaltyWeight: number;
  suggestivePenaltyWeight: number;
  explicitDomainScore: number;
  explicitDomainOnlyScore: number;
  suggestiveAdultSiteScore: number;
  adultLinkScore: number;
};

type ScoredContext = {
  domain: string;
  srcText: string;
  attrText: string;
  localText: string;
  pageText: string;
  queryText: string;
  pageUrlText: string;
  width: number;
  height: number;
  area: number;
  isLikelyPreview: boolean;
  isTinyThumbnail: boolean;
  isLargeHero: boolean;
  onSearchPage: boolean;
};

const EXPLICIT_PATTERNS: WeightedPattern[] = [
  { pattern: /\b(nude|nudity|naked|fully nude|topless)\b/i, score: 0.88, reason: "nudity keyword" },
  { pattern: /\b(porn|porno|pornhub|xvideos|xnxx|redtube|brazzers|youporn|xhamster|rule34|r34)\b/i, score: 0.99, reason: "porn keyword" },
  { pattern: /\b(sex|sexual|hardcore|blowjob|handjob|cumshot|deepthroat|doggystyle|orgy|gangbang)\b/i, score: 0.98, reason: "sexual act keyword" },
  { pattern: /\b(nipple|nipples|nip slip|nipslip|areola)\b/i, score: 0.94, reason: "nipple exposure keyword" },
  { pattern: /\b(genital|genitals|labia|vagina|penis|cock|dick|pussy|clit|testicles?)\b/i, score: 0.99, reason: "genital keyword" },
  { pattern: /\b(masturbat|penetrat|creampie|anal|oral sex|facial|squirt|bukkake)\w*\b/i, score: 0.99, reason: "pornographic act keyword" },
  { pattern: /\b(onlyfans|fansly|nsfw|sexcam|camgirl|camgirls|escort)\b/i, score: 0.9, reason: "adult platform keyword" },
  { pattern: /\b(milf|hentai|stepmom|nsfw leak|nude leak|leaked nudes)\b/i, score: 0.95, reason: "adult intent keyword" },
];

const SUGGESTIVE_PATTERNS: WeightedPattern[] = [
  { pattern: /\b(lingerie|underwear|panties|thong|g-string|bikini|microkini|swimsuit)\b/i, score: 0.8, reason: "revealing clothing keyword" },
  { pattern: /\b(cleavage|busty|boobs?|braless|sideboob|underboob)\b/i, score: 0.88, reason: "chest emphasis keyword" },
  { pattern: /\b(sheer|see[- ]?through|transparent|wet look|wet shirt|wet clothes)\b/i, score: 0.91, reason: "transparent clothing keyword" },
  { pattern: /\b(seductive|provocative|sexy|sensual|tease|teasing|flirty)\b/i, score: 0.78, reason: "sexualized language" },
  { pattern: /\b(fetish|latex|fishnet|corset|stockings?|garter|bodysuit)\b/i, score: 0.86, reason: "fetish styling keyword" },
  { pattern: /\b(arched back|spread legs|cameltoe|wardrobe malfunction|nip slip)\b/i, score: 0.92, reason: "sexual pose keyword" },
  { pattern: /\b(thighs?|booty|ass|butt|hips?|curves?)\b/i, score: 0.72, reason: "body emphasis keyword" },
  { pattern: /\b(model|glamour|boudoir|pinup)\b/i, score: 0.7, reason: "glamour context keyword" },
  { pattern: /\b(miniskirt|crop top|low rise|plunging neckline)\b/i, score: 0.74, reason: "provocative outfit keyword" },
  { pattern: /\b(hot girl|hot girls|sexy pics|sexy photo|babe|babes|adult model)\b/i, score: 0.8, reason: "sexualized search phrase" },
  { pattern: /\b(try on haul|lingerie haul|bikini haul|transparent haul)\b/i, score: 0.84, reason: "provocative content phrase" },
];

const SAFE_PATTERNS: WeightedPattern[] = [
  { pattern: /\b(news|article|press|conference|interview|tutorial|recipe|school|classroom)\b/i, score: 0.16, reason: "editorial context" },
  { pattern: /\b(product|catalog|store|size chart|lookbook|editorial)\b/i, score: 0.09, reason: "shopping context" },
  { pattern: /\b(team|sports|wedding|travel|landscape|architecture|documentary)\b/i, score: 0.11, reason: "non-sexual context" },
];

const CLOTHING_PATTERNS = [
  /\b(lingerie|underwear|panties|thong|bikini|microkini|swimsuit|bodysuit)\b/i,
  /\b(sheer|transparent|see[- ]?through|fishnet|latex|corset)\b/i,
];

const BODY_FOCUS_PATTERNS = [
  /\b(cleavage|boobs?|sideboob|underboob|thighs?|booty|butt|ass|hips?)\b/i,
  /\b(arched back|spread legs|cameltoe|wardrobe malfunction)\b/i,
];

const SAFE_DOMAIN_HINTS = ["amazon", "etsy", "wikipedia", "bbc", "nytimes"];
const EXPLICIT_DOMAINS = ["pornhub", "xvideos", "xnxx", "redtube", "youporn", "xhamster", "onlyfans", "fansly"];
const SUGGESTIVE_DOMAINS = ["playboy", "maxim", "fapello", "bikinis", "lingerie", "boudoir"];
const SEARCH_ENGINES = ["google.", "bing.", "search.yahoo.", "duckduckgo.", "yandex."];
const SEARCH_PARAM_NAMES = ["q", "p", "query", "text", "search", "wd", "k"];
const ADULT_URL_HINTS = [
  "porn",
  "xxx",
  "nsfw",
  "adult",
  "sex",
  "hentai",
  "nude",
  "naked",
  "onlyfans",
  "fansly",
];

const PAGE_CONTEXT_SELECTOR =
  "title,meta[name='description'],meta[property='og:title'],meta[property='og:description'],h1,h2,figcaption";

const sessionRiskMemory = new Map<string, RiskMemory>();
let pageContextCache:
  | {
      key: string;
      value: string;
    }
  | undefined;

const SENSITIVITY_PROFILES: Record<Sensitivity, SensitivityProfile> = {
  low: {
    explicitThreshold: 0.94,
    suggestiveThreshold: 0.68,
    suggestiveBlockThreshold: 1,
    explicitPenaltyWeight: 0.22,
    suggestivePenaltyWeight: 1,
    explicitDomainScore: 0.84,
    explicitDomainOnlyScore: 0.18,
    suggestiveAdultSiteScore: 0.24,
    adultLinkScore: 0.06,
  },
  balanced: {
    explicitThreshold: 0.9,
    suggestiveThreshold: 0.58,
    suggestiveBlockThreshold: 0.72,
    explicitPenaltyWeight: 0.16,
    suggestivePenaltyWeight: 0.92,
    explicitDomainScore: 0.9,
    explicitDomainOnlyScore: 0.32,
    suggestiveAdultSiteScore: 0.86,
    adultLinkScore: 0.18,
  },
  strict: {
    explicitThreshold: 0.82,
    suggestiveThreshold: 0.46,
    suggestiveBlockThreshold: 0.58,
    explicitPenaltyWeight: 0.08,
    suggestivePenaltyWeight: 0.58,
    explicitDomainScore: 0.99,
    explicitDomainOnlyScore: 0.52,
    suggestiveAdultSiteScore: 0.92,
    adultLinkScore: 0.24,
  },
};

export function createClassifier(options: ClassifierOptions): Classifier {
  switch (options.backend) {
    case "pattern":
      return new PatternClassifier(options.sensitivity);
    case "api":
      if (!options.apiConfig) {
        throw new Error('[BlurGuard] backend="api" requires apiConfig');
      }
      return new ApiClassifier(options.apiConfig, options.sensitivity);
  }
}

class PatternClassifier implements Classifier {
  private sensitivity: Sensitivity;
  private cache = new Map<string, ClassificationResult>();

  constructor(sensitivity: Sensitivity) {
    this.sensitivity = sensitivity;
  }

  async classify(
    el: HTMLImageElement | HTMLVideoElement
  ): Promise<ClassificationResult> {
    const src = resolveSrc(el);
    const context = collectContext(el);
    const cacheKey = `${this.sensitivity}:${src}:${getElementFingerprint(el)}:${context.domain}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const result = scoreContext(context, this.sensitivity);
    learnFromResult(context.domain, result);
    this.cache.set(cacheKey, result);
    return result;
  }

  dispose(): void {
    this.cache.clear();
  }
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
    if (!src) return safeResult();

    const cached = this.cache.get(src);
    if (cached) return cached;

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
        return safeResult();
      }

      const json: unknown = await response.json();
      const confidence = clampConfidence(
        extractConfidence(json, this.config.responsePath ?? "confidence")
      );
      const category =
        confidence >= 0.92
          ? "explicit"
          : confidence >= 0.7
            ? "suggestive"
            : "safe";
      const result = finalizeResult(category, confidence, this.sensitivity, [
        "remote classifier",
      ]);

      this.cache.set(src, result);
      return result;
    } catch (error) {
      console.warn("[BlurGuard] API classify error:", error);
      return safeResult();
    }
  }

  dispose(): void {
    this.cache.clear();
  }
}

function scoreContext(
  context: ScoredContext,
  sensitivity: Sensitivity
): ClassificationResult {
  const profile = SENSITIVITY_PROFILES[sensitivity];
  const explicitHits = [
    ...weightedMatches(context.srcText, EXPLICIT_PATTERNS, 1.12),
    ...weightedMatches(context.attrText, EXPLICIT_PATTERNS, 1.04),
    ...weightedMatches(context.localText, EXPLICIT_PATTERNS, 0.96),
    ...weightedMatches(context.pageText, EXPLICIT_PATTERNS, 0.72),
    ...weightedMatches(context.queryText, EXPLICIT_PATTERNS, 1.18),
    ...weightedMatches(context.pageUrlText, EXPLICIT_PATTERNS, 0.84),
    ...explicitSiteSignals(context, profile),
    ...searchIntentSignals(context),
  ];

  const suggestiveHits = [
    ...weightedMatches(context.srcText, SUGGESTIVE_PATTERNS, 1.08),
    ...weightedMatches(context.attrText, SUGGESTIVE_PATTERNS, 1.02),
    ...weightedMatches(context.localText, SUGGESTIVE_PATTERNS, 0.95),
    ...weightedMatches(context.pageText, SUGGESTIVE_PATTERNS, 0.68),
    ...weightedMatches(context.queryText, SUGGESTIVE_PATTERNS, 1.12),
    ...weightedMatches(context.pageUrlText, SUGGESTIVE_PATTERNS, 0.8),
    ...matchDomain(context.domain, SUGGESTIVE_DOMAINS, 0.78, "sexualized domain"),
    ...adultSiteSignals(context, sensitivity, profile),
    ...framingSignals(context),
    ...compoundSignals(context),
    ...memorySignals(context.domain),
    ...queryEscalationSignals(context),
  ];

  const safePenalty = Math.min(
    0.22,
    weightedMatches(context.pageText, SAFE_PATTERNS, 1).reduce(
      (sum, hit) => sum + hit.score * 0.55,
      0
    ) +
      weightedMatches(context.localText, SAFE_PATTERNS, 1).reduce(
        (sum, hit) => sum + hit.score * 0.35,
        0
      ) +
      safeDomainPenalty(context.domain)
  );

  const explicitScore = normalizeScore(
    explicitHits,
    safePenalty * profile.explicitPenaltyWeight
  );
  const suggestiveScore = normalizeScore(
    suggestiveHits,
    safePenalty * profile.suggestivePenaltyWeight
  );

  let category: DetectionCategory = "safe";
  let confidence = 0;
  let reasons: string[] = [];

  const explicitThreshold = profile.explicitThreshold;
  const suggestiveThreshold = profile.suggestiveThreshold;

  if (explicitScore >= explicitThreshold) {
    category = "explicit";
    confidence = explicitScore;
    reasons = explicitHits.map((hit) => hit.reason);
  } else if (suggestiveScore >= suggestiveThreshold) {
    category = "suggestive";
    confidence = suggestiveScore;
    reasons = suggestiveHits.map((hit) => hit.reason);
  } else {
    confidence = Math.max(explicitScore, suggestiveScore * 0.48);
  }

  return finalizeResult(category, confidence, sensitivity, reasons);
}

function collectContext(el: HTMLImageElement | HTMLVideoElement): ScoredContext {
  const src = resolveSrc(el);
  const anchor = el.closest("a");
  const container = el.closest("figure,article,section,aside,li,div");
  const width =
    el instanceof HTMLImageElement
      ? el.naturalWidth || el.width || el.clientWidth
      : el.videoWidth || el.clientWidth;
  const height =
    el instanceof HTMLImageElement
      ? el.naturalHeight || el.height || el.clientHeight
      : el.videoHeight || el.clientHeight;
  const area = width * height;

  let domain = location.hostname;
  try {
    domain = src ? new URL(src, location.href).hostname : location.hostname;
  } catch {
    domain = location.hostname;
  }

  const srcText = normalizeText([
    src,
    anchor?.getAttribute("href"),
    domain,
  ]);

  const attrText = normalizeText([
    el.getAttribute("alt"),
    el.getAttribute("title"),
    el.getAttribute("aria-label"),
    el.getAttribute("class"),
    el.getAttribute("id"),
    anchor?.getAttribute("aria-label"),
  ]);

  const localText = normalizeText([
    anchor?.textContent,
    extractNearbyText(container),
  ]);

  const pageText = getCachedPageContext();
  const queryText = getSearchIntentText();
  const pageUrlText = normalizeText([location.href, location.pathname]);
  const onSearchPage = SEARCH_ENGINES.some((engine) =>
    location.hostname.includes(engine)
  );

  return {
    domain: domain.toLowerCase(),
    srcText,
    attrText,
    localText,
    pageText,
    queryText,
    pageUrlText,
    width,
    height,
    area,
    isLikelyPreview:
      area > 0 &&
      area < 220_000 &&
      (width >= height * 1.15 || height >= width * 1.15),
    isTinyThumbnail: area > 0 && area < 48_000,
    isLargeHero: area >= 280_000,
    onSearchPage,
  };
}

function getSearchIntentText(): string {
  const url = new URL(location.href);
  const values: string[] = [];
  for (const name of SEARCH_PARAM_NAMES) {
    const value = url.searchParams.get(name);
    if (value) values.push(value);
  }
  return normalizeText(values);
}

function getCachedPageContext(): string {
  const key = `${location.href}|${document.title}`;
  if (pageContextCache?.key === key) {
    return pageContextCache.value;
  }

  const bits: string[] = [document.title];
  for (const node of document.querySelectorAll(PAGE_CONTEXT_SELECTOR)) {
    if (bits.length >= 12) break;
    if (node instanceof HTMLMetaElement) {
      if (node.content) bits.push(node.content);
    } else if (node.textContent) {
      bits.push(node.textContent);
    }
  }

  const value = normalizeText(bits);
  pageContextCache = { key, value };
  return value;
}

function extractNearbyText(node: Element | null): string {
  if (!node) return "";
  const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return text.slice(0, 320);
}

function normalizeText(parts: Array<string | null | undefined>): string {
  return parts
    .filter(Boolean)
    .join(" ")
    .replace(/[_\-./=?&#:%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function weightedMatches(
  text: string,
  patterns: WeightedPattern[],
  multiplier: number
): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  for (const { pattern, score, reason } of patterns) {
    if (pattern.test(text)) {
      hits.push({
        score: clampConfidence(score * multiplier),
        reason,
      });
    }
  }
  return hits;
}

function compoundSignals(context: ScoredContext): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const combined = `${context.srcText} ${context.attrText} ${context.localText}`;
  const hasProvocativeClothing = CLOTHING_PATTERNS.some((pattern) =>
    pattern.test(combined)
  );
  const hasBodyFocus = BODY_FOCUS_PATTERNS.some((pattern) =>
    pattern.test(combined)
  );

  if (hasProvocativeClothing && hasBodyFocus) {
    hits.push({ score: 0.92, reason: "combined clothing and body-focus cues" });
  }
  if (context.isLikelyPreview && hasBodyFocus) {
    hits.push({ score: 0.14, reason: "cropped preview with body focus" });
  }
  if (context.isTinyThumbnail && (hasProvocativeClothing || hasBodyFocus)) {
    hits.push({ score: 0.08, reason: "thumbnail hiding detail" });
  }
  if (context.isLargeHero && hasProvocativeClothing) {
    hits.push({ score: 0.06, reason: "large hero image with provocative styling" });
  }
  if (context.queryText && hasProvocativeClothing) {
    hits.push({ score: 0.1, reason: "provocative clothing on an adult-leaning page" });
  }
  if (context.queryText && hasBodyFocus) {
    hits.push({ score: 0.12, reason: "body-focus content on an adult-leaning page" });
  }

  return hits;
}

function framingSignals(context: ScoredContext): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  if (context.isLikelyPreview) {
    hits.push({ score: 0.12, reason: "thumbnail-style framing" });
  }
  if (context.width > 0 && context.height > 0) {
    const ratio = context.width / context.height;
    if (ratio > 1.45 || ratio < 0.72) {
      hits.push({ score: 0.08, reason: "cropped focus framing" });
    }
  }
  return hits;
}

function memorySignals(domain: string): HeuristicHit[] {
  const memory = sessionRiskMemory.get(domain);
  if (!memory) return [];

  const hits: HeuristicHit[] = [];
  if (memory.explicit > 0) {
    hits.push({
      score: Math.min(0.18, memory.explicit * 0.06),
      reason: "repeat explicit signals on this domain",
    });
  }
  if (memory.suggestive > 0) {
    hits.push({
      score: Math.min(0.12, memory.suggestive * 0.04),
      reason: "repeat suggestive signals on this domain",
    });
  }
  return hits;
}

function searchIntentSignals(context: ScoredContext): HeuristicHit[] {
  if (!context.queryText || !context.onSearchPage) return [];

  const hits: HeuristicHit[] = [];
  if (weightedMatches(context.queryText, EXPLICIT_PATTERNS, 1).length > 0) {
    hits.push({ score: 0.22, reason: "explicit search intent" });
  }
  if (/\b(nude|porn|sex|xxx|hentai|milf|onlyfans|naked)\b/i.test(context.queryText)) {
    hits.push({ score: 0.18, reason: "adult search query" });
  }
  return hits;
}

function queryEscalationSignals(context: ScoredContext): HeuristicHit[] {
  if (!context.queryText) return [];

  const hits: HeuristicHit[] = [];
  if (weightedMatches(context.queryText, SUGGESTIVE_PATTERNS, 1).length > 0) {
    hits.push({ score: 0.12, reason: "suggestive search intent" });
  }
  if (context.onSearchPage && /\b(nude|sexy|lingerie|bikini|braless|cleavage)\b/i.test(context.queryText)) {
    hits.push({ score: 0.15, reason: "adult-leaning search query" });
  }
  return hits;
}

function explicitSiteSignals(
  context: ScoredContext,
  profile: SensitivityProfile
): HeuristicHit[] {
  const hits: HeuristicHit[] = [];
  const onExplicitDomain = EXPLICIT_DOMAINS.some((pattern) =>
    context.domain.includes(pattern)
  );

  if (!onExplicitDomain) {
    return hits;
  }

  const hasExplicitTextSignal =
    weightedMatches(context.srcText, EXPLICIT_PATTERNS, 1).length > 0 ||
    weightedMatches(context.attrText, EXPLICIT_PATTERNS, 1).length > 0 ||
    weightedMatches(context.localText, EXPLICIT_PATTERNS, 1).length > 0 ||
    weightedMatches(context.pageUrlText, EXPLICIT_PATTERNS, 1).length > 0;

  hits.push({
    score: hasExplicitTextSignal
      ? profile.explicitDomainScore
      : profile.explicitDomainOnlyScore,
    reason: hasExplicitTextSignal
      ? "adult domain with explicit text cues"
      : "adult domain only",
  });

  return hits;
}

function adultSiteSignals(
  context: ScoredContext,
  sensitivity: Sensitivity,
  profile: SensitivityProfile
): HeuristicHit[] {
  if (sensitivity === "low") {
    return [];
  }

  const hits: HeuristicHit[] = [];
  const onExplicitDomain = EXPLICIT_DOMAINS.some((pattern) =>
    context.domain.includes(pattern)
  );

  if (onExplicitDomain) {
    hits.push({
      score: profile.suggestiveAdultSiteScore,
      reason: "adult website context",
    });
  }

  if (hasAdultUrlHint(context)) {
    hits.push({
      score: profile.adultLinkScore,
      reason: "adult website link",
    });
  }

  return hits;
}

function hasAdultUrlHint(context: ScoredContext): boolean {
  const combined = `${context.srcText} ${context.pageUrlText}`;
  return ADULT_URL_HINTS.some((hint) => combined.includes(hint));
}

function learnFromResult(domain: string, result: ClassificationResult): void {
  if (!domain || result.category === "safe") return;

  const current = sessionRiskMemory.get(domain) ?? {
    suggestive: 0,
    explicit: 0,
  };

  if (result.category === "explicit") {
    current.explicit = Math.min(4, current.explicit + 1);
  }
  if (result.category === "suggestive") {
    current.suggestive = Math.min(4, current.suggestive + 1);
  }

  sessionRiskMemory.set(domain, current);
}

function safeDomainPenalty(domain: string): number {
  return SAFE_DOMAIN_HINTS.some((hint) => domain.includes(hint)) ? 0.06 : 0;
}

function matchDomain(
  domain: string,
  patterns: string[],
  score: number,
  reason: string
): HeuristicHit[] {
  return patterns
    .filter((pattern) => domain.includes(pattern))
    .map(() => ({ score, reason }));
}

function normalizeScore(hits: HeuristicHit[], penalty: number): number {
  if (hits.length === 0) {
    return 0;
  }

  const strongest = Math.max(...hits.map((hit) => hit.score));
  const support = Math.min(0.2, (hits.length - 1) * 0.04);
  const stacked = Math.min(
    0.18,
    hits
      .map((hit) => hit.score)
      .sort((a, b) => b - a)
      .slice(1, 4)
      .reduce((sum, score) => sum + score * 0.08, 0)
  );
  return clampConfidence(strongest + support + stacked - penalty);
}

function finalizeResult(
  category: DetectionCategory,
  confidence: number,
  sensitivity: Sensitivity,
  reasons: string[]
): ClassificationResult {
  const profile = SENSITIVITY_PROFILES[sensitivity];
  const normalized = clampConfidence(confidence);
  const shouldBlock =
    category === "explicit" ||
    (category === "suggestive" &&
      normalized >= profile.suggestiveBlockThreshold);

  return {
    category,
    confidence: normalized,
    shouldBlock,
    reasons: uniqueReasons(reasons),
  };
}

function uniqueReasons(reasons: string[]): string[] {
  return Array.from(new Set(reasons)).slice(0, 4);
}

function safeResult(): ClassificationResult {
  return {
    category: "safe",
    confidence: 0,
    shouldBlock: false,
    reasons: [],
  };
}

function resolveSrc(el: HTMLImageElement | HTMLVideoElement): string {
  if (el instanceof HTMLImageElement) {
    return el.currentSrc || el.src || el.getAttribute("src") || "";
  }

  return el.currentSrc || el.src || el.querySelector("source")?.src || "";
}

function getElementFingerprint(el: HTMLImageElement | HTMLVideoElement): string {
  return [
    el.getAttribute("alt"),
    el.getAttribute("title"),
    el.getAttribute("class"),
    el.getAttribute("id"),
    el.closest("a")?.getAttribute("href"),
  ]
    .filter(Boolean)
    .join("|");
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.99)) : 0;
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

  return Number(cursor);
}
