// src/components/blurguard/QuickActions.tsx
// Disable / pause buttons wired to background via setEnabled prop.

import { Button } from "@/components/ui/button";
import { ArrowRight, Pause, Shield, ShieldOff } from "lucide-react";

interface Props {
  enabled: boolean;
  onToggleEnabled: () => void;
}

const QuickActions = ({ enabled, onToggleEnabled }: Props) => {
  return (
    <div className="mx-4 space-y-2">
      <div className="flex gap-2">
        <Button
          onClick={onToggleEnabled}
          className={`flex-1 text-xs h-9 font-semibold transition-all ${
            enabled
              ? "glow-pink hover:glow-pink bg-primary text-primary-foreground"
              : "bg-success/10 border border-success/30 text-success hover:bg-success/20"
          }`}
          size="sm">
          {enabled ? (
            <>
              <ShieldOff className="h-3.5 w-3.5" /> Disable Protection
            </>
          ) : (
            <>
              <Shield className="h-3.5 w-3.5" /> Enable Protection
            </>
          )}
        </Button>

        <Button
          variant="outline"
          className="flex-1 text-xs h-9 font-medium border-border hover:bg-secondary"
          size="sm"
          disabled={!enabled}>
          <Pause className="h-3.5 w-3.5" />
          Pause 5 min
        </Button>
      </div>

      <button className="flex items-center gap-1 text-[11px] text-primary hover:text-primary/80 transition-colors font-medium mx-auto">
        View Full Activity
        <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
};

export default QuickActions;
