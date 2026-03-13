// src/components/blurguard/DetectionFeed.tsx
// Shows live detection events pushed from background via useBlurGuard hook.
// Highlights the newest event with a subtle flash animation.

import { ScrollArea } from "@/components/ui/scroll-area";
import type { DetectionEvent } from "@/types/messages";

interface Props {
  feed: DetectionEvent[];
}

// Confidence → severity tier
function severity(confidence: number): "high" | "medium" | "low" {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

const severityDot: Record<"high" | "medium" | "low", string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-success",
};

function relativeTime(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function feedLabel(event: DetectionEvent): string {
  if (event.kind === "video") return "Video blurred";
  if (event.confidence >= 0.8) return "Explicit image blocked";
  if (event.confidence >= 0.55) return "AI flagged potential content";
  return "Suspicious thumbnail detected";
}

const DetectionFeed = ({ feed }: Props) => {
  return (
    <div className="mx-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Recent Activity
      </h3>

      <ScrollArea className="h-[160px] rounded-lg bg-card border border-border">
        {feed.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <p className="text-[11px] text-muted-foreground">
              No detections yet
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {feed.map((event, i) => {
              const sev = severity(event.confidence);
              return (
                <div
                  key={event.id}
                  className={`flex items-start gap-2.5 rounded-md px-3 py-2.5 transition-colors hover:bg-secondary/60 cursor-default ${
                    i === 0 ? "animate-fade-in" : ""
                  }`}>
                  <div
                    className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${severityDot[sev]}`}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-foreground leading-snug">
                      {feedLabel(event)}{" "}
                      <span className="text-muted-foreground">on</span>{" "}
                      <span className="text-primary font-medium truncate">
                        {event.domain}
                      </span>
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">
                        {relativeTime(event.timestamp)}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50">
                        ·
                      </span>
                      <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                        {Math.round(event.confidence * 100)}% conf.
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
};

export default DetectionFeed;
