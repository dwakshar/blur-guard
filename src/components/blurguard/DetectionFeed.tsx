import { ScrollArea } from "@/components/ui/scroll-area";

type Severity = "high" | "medium" | "low";

interface FeedItem {
  id: number;
  message: string;
  domain: string;
  time: string;
  severity: Severity;
}

const feedItems: FeedItem[] = [
  { id: 1, message: "Explicit image blocked", domain: "reddit.com", time: "2m ago", severity: "high" },
  { id: 2, message: "Video blurred", domain: "unknown-site.xyz", time: "8m ago", severity: "high" },
  { id: 3, message: "AI flagged potential content", domain: "imgur.com", time: "14m ago", severity: "medium" },
  { id: 4, message: "Suspicious thumbnail detected", domain: "twitter.com", time: "31m ago", severity: "low" },
];

const severityColors: Record<Severity, string> = {
  high: "bg-destructive",
  medium: "bg-warning",
  low: "bg-success",
};

const DetectionFeed = () => {
  return (
    <div className="mx-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Recent Activity
      </h3>
      <ScrollArea className="h-[160px] rounded-lg bg-card border border-border">
        <div className="p-2 space-y-1">
          {feedItems.map((item, i) => (
            <div
              key={item.id}
              className="flex items-start gap-2.5 rounded-md px-3 py-2.5 transition-colors hover:bg-secondary/60 cursor-default"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${severityColors[item.severity]}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-foreground leading-snug">
                  {item.message}{" "}
                  <span className="text-muted-foreground">on</span>{" "}
                  <span className="text-primary font-medium">{item.domain}</span>
                </p>
                <span className="text-[10px] text-muted-foreground">{item.time}</span>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
};

export default DetectionFeed;
