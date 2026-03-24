// src/components/blurguard/QuickActions.tsx
// Disable / pause buttons wired to background via popup actions.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, RotateCcw, Shield, ShieldOff } from "lucide-react";

interface Props {
  enabled: boolean;
  pausedUntil: number;
  onToggleEnabled: () => void;
  onPause: () => void;
  onResetStats: () => void;
  onResume: () => void;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

const QuickActions = ({
  enabled,
  pausedUntil,
  onToggleEnabled,
  onPause,
  onResetStats,
  onResume,
}: Props) => {
  const [remainingMs, setRemainingMs] = useState(0);
  const isPaused = pausedUntil > Date.now();

  useEffect(() => {
    if (pausedUntil <= Date.now()) {
      setRemainingMs(0);
      return;
    }

    setRemainingMs(pausedUntil - Date.now());
    const timer = window.setInterval(() => {
      const nextRemaining = pausedUntil - Date.now();
      if (nextRemaining <= 0) {
        setRemainingMs(0);
        window.clearInterval(timer);
        onResume();
        return;
      }

      setRemainingMs(nextRemaining);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [onResume, pausedUntil]);

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
          onClick={onPause}
          variant="outline"
          className="flex-1 text-xs h-9 font-medium border-border hover:bg-secondary"
          size="sm"
          disabled={!enabled}>
          <Pause className="h-3.5 w-3.5" />
          {isPaused ? `Resuming in ${formatCountdown(remainingMs)}` : "Pause 5 min"}
        </Button>
      </div>

      <Button
        onClick={() => {
          if (window.confirm("Reset all BlurGuard statistics?")) {
            onResetStats();
          }
        }}
        variant="outline"
        className="w-full text-xs h-9 font-medium border-border hover:bg-secondary"
        size="sm">
        <RotateCcw className="h-3.5 w-3.5" />
        Reset Stats
      </Button>
    </div>
  );
};

export default QuickActions;
