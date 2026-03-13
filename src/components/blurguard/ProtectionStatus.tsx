// src/components/blurguard/ProtectionStatus.tsx
// Displays live scanned + blocked counters from background state.

import type { BlurGuardState } from "@/types/messages";
import { Ban, Image, Video } from "lucide-react";

interface Props {
  stats: BlurGuardState["stats"];
  enabled: boolean;
}

const ProtectionStatus = ({ stats, enabled }: Props) => {
  const items = [
    { icon: Image, label: "Images", value: stats.images },
    { icon: Video, label: "Videos", value: stats.videos },
    { icon: Ban, label: "Blocked", value: stats.blocked },
  ];

  return (
    <div className="mx-4 rounded-lg bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="relative">
          <div
            className={`h-2.5 w-2.5 rounded-full ${
              enabled ? "bg-success" : "bg-muted-foreground"
            }`}
          />
          {enabled && (
            <div className="absolute inset-0 rounded-full bg-success animate-pulse-glow glow-green" />
          )}
        </div>
        <span className="text-sm font-semibold text-foreground">
          {enabled ? "Protection Active" : "Protection Paused"}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {items.map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="flex flex-col items-center rounded-md bg-secondary/60 py-3 px-2 transition-colors hover:bg-secondary">
            <Icon className="h-4 w-4 text-muted-foreground mb-1.5" />
            <span className="text-lg font-bold text-foreground leading-none tabular-nums">
              {value.toLocaleString()}
            </span>
            <span className="text-[10px] text-muted-foreground mt-1">
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProtectionStatus;
