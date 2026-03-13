import { Progress } from "@/components/ui/progress";
import { BarChart3, Globe, Zap } from "lucide-react";

const SafetyInsights = () => {
  return (
    <div className="mx-4 pb-5">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Safety Insights
      </h3>
      <div className="space-y-2">
        {/* Blocked today */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <BarChart3 className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <span className="text-xs text-foreground font-medium">34 blocked today</span>
            <div className="flex gap-0.5 mt-1.5">
              {[60, 40, 80, 30, 90, 55, 70].map((h, i) => (
                <div
                  key={i}
                  className="w-3 rounded-sm bg-primary/60"
                  style={{ height: `${h / 6}px` }}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Top domains */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Globe className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <span className="text-xs text-foreground font-medium">Top domains</span>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              reddit.com · imgur.com · twitter.com
            </p>
          </div>
        </div>

        {/* AI Accuracy */}
        <div className="flex items-center gap-3 rounded-lg bg-card border border-border px-3 py-2.5">
          <Zap className="h-4 w-4 text-primary shrink-0" />
          <div className="flex-1">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-foreground font-medium">AI Accuracy</span>
              <span className="text-[10px] text-primary font-bold">98.7%</span>
            </div>
            <Progress value={98.7} className="mt-1.5 h-1.5 bg-secondary" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default SafetyInsights;
