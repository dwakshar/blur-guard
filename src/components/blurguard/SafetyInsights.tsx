// src/components/blurguard/SafetyInsights.tsx
// Live stats panel: blocked count sparkline, top domains, confidence bar.

import { Progress } from "@/components/ui/progress";
import type { BlurGuardState, DetectionEvent } from "@/types/messages";
import { BarChart3, Globe, Zap } from "lucide-react";

interface Props {
  stats: BlurGuardState["stats"];
  feed: DetectionEvent[];
}

function topDomains(feed: DetectionEvent[]): string[] {
  const counts: Record<string, number> = {};

  for (const event of feed) {
    counts[event.domain] = (counts[event.domain] ?? 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([domain]) => domain);
}

function sparkline(feed: DetectionEvent[]): number[] {
  const now = Date.now();
  const buckets: number[] = Array(7).fill(0);

  for (const event of feed) {
    const diffMs = now - event.timestamp;
    if (diffMs < 0) continue;

    const hourOffset = Math.floor(diffMs / (60 * 60 * 1000));
    if (hourOffset >= 7) continue;

    buckets[6 - hourOffset] += 1;
  }

  const maxCount = Math.max(...buckets, 0);
  if (maxCount === 0) {
    return buckets.map(() => 10);
  }

  return buckets.map((count) => Math.max(10, (count / maxCount) * 100));
}

function avgConfidence(feed: DetectionEvent[]): number {
  if (feed.length === 0) return 0;

  const sum = feed.reduce((acc, event) => acc + event.confidence, 0);
  return Number(((sum / feed.length) * 100).toFixed(1));
}

const SafetyInsights = ({ stats, feed }: Props) => {
  const domains = topDomains(feed);
  const bars = sparkline(feed);
  const accuracy = avgConfidence(feed);

  return (
    <div className="mx-4 pb-5">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Safety Insights
      </h3>
      <div className="space-y-2">
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <BarChart3 className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <span className="text-xs text-foreground font-medium">
              {stats.blocked.toLocaleString()} blocked today
            </span>
            <div className="mt-1.5 flex h-8 items-end gap-0.5">
              {bars.map((height, i) => (
                <div
                  key={i}
                  className="w-3 rounded-sm transition-all duration-500"
                  style={{
                    height: `${height}%`,
                    background:
                      height > 10
                        ? "hsl(340 100% 50% / 0.85)"
                        : "hsl(340 30% 30% / 0.35)",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Globe className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-foreground font-medium">
              Top domains
            </span>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
              {domains.length > 0
                ? domains.join(" \u00B7 ")
                : "No detections yet"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Zap className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-foreground font-medium">
                AI Accuracy
              </span>
              <span className="text-[10px] font-bold tabular-nums text-primary">
                {feed.length > 0 ? `${accuracy.toFixed(1)}%` : "\u2014"}
              </span>
            </div>
            <Progress value={accuracy} className="mt-1.5 h-1.5 bg-secondary" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SafetyInsights;
