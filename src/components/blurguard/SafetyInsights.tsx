// src/components/blurguard/SafetyInsights.tsx
// Live stats panel: blocked count sparkline, top domains, confidence bar.

import { Progress } from "@/components/ui/progress";
import type { BlurGuardState, DetectionEvent } from "@/types/messages";
import { BarChart3, Globe, Zap } from "lucide-react";

interface Props {
  stats: BlurGuardState["stats"];
  feed: DetectionEvent[];
}

/** Returns unique domains from feed, most-frequent first, max 3 */
function topDomains(feed: DetectionEvent[]): string[] {
  const counts: Record<string, number> = {};
  for (const e of feed) counts[e.domain] = (counts[e.domain] ?? 0) + 1;
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([d]) => d);
}

/** Build a 7-bar sparkline from the last 7 detections' confidence values */
function sparkline(feed: DetectionEvent[]): number[] {
  const recent = feed.slice(0, 7).reverse();
  // Pad to 7 bars so layout is stable when few events exist
  while (recent.length < 7) recent.unshift({ confidence: 0 } as DetectionEvent);
  return recent.map((e) => e.confidence);
}

/** Average confidence across the feed, interpreted as "AI Accuracy" */
function avgConfidence(feed: DetectionEvent[]): number {
  if (feed.length === 0) return 0;
  const sum = feed.reduce((acc, e) => acc + e.confidence, 0);
  return sum / feed.length;
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
        {/* Blocked today with sparkline */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <BarChart3 className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <span className="text-xs text-foreground font-medium">
              {stats.blocked.toLocaleString()} blocked total
            </span>
            <div className="flex items-end gap-0.5 mt-1.5">
              {bars.map((conf, i) => (
                <div
                  key={i}
                  className="w-3 rounded-sm transition-all duration-500"
                  style={{
                    height: `${Math.max(2, conf * 14)}px`,
                    background:
                      conf > 0
                        ? `hsl(340 100% 50% / ${0.4 + conf * 0.5})`
                        : "hsl(0 0% 16%)",
                  }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Top detected domains */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Globe className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1 min-w-0">
            <span className="text-xs text-foreground font-medium">
              Top domains
            </span>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {domains.length > 0 ? domains.join(" · ") : "No detections yet"}
            </p>
          </div>
        </div>

        {/* Classifier confidence bar */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Zap className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-foreground font-medium">
                Avg. Confidence
              </span>
              <span className="text-[10px] text-primary font-bold tabular-nums">
                {feed.length > 0 ? `${Math.round(accuracy * 100)}%` : "—"}
              </span>
            </div>
            <Progress
              value={accuracy * 100}
              className="mt-1.5 h-1.5 bg-secondary"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SafetyInsights;
