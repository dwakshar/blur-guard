import { ShieldOff, Pause, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const QuickActions = () => {
  return (
    <div className="mx-4 space-y-2">
      <div className="flex gap-2">
        <Button
          className="flex-1 glow-pink hover:glow-pink text-xs h-9 font-semibold"
          size="sm"
        >
          <ShieldOff className="h-3.5 w-3.5" />
          Disable Protection
        </Button>
        <Button
          variant="outline"
          className="flex-1 text-xs h-9 font-medium border-border hover:bg-secondary"
          size="sm"
        >
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
