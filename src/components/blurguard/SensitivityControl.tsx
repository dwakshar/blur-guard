// src/components/blurguard/SensitivityControl.tsx
// Sensitivity toggle — wired to background via setSensitivity prop.

import type { Sensitivity } from "@/types/messages";

const levels = [
  {
    key: "low" as Sensitivity,
    label: "Low",
    desc: "Only blocks highly explicit content.",
  },
  {
    key: "balanced" as Sensitivity,
    label: "Balanced",
    desc: "Smart filtering for most situations.",
  },
  {
    key: "strict" as Sensitivity,
    label: "Strict",
    desc: "Aggressively blocks anything suggestive.",
  },
];

interface Props {
  sensitivity: Sensitivity;
  onChangeSensitivity: (s: Sensitivity) => void;
}

const SensitivityControl = ({ sensitivity, onChangeSensitivity }: Props) => {
  const activeLevel = levels.find((l) => l.key === sensitivity) ?? levels[1];

  return (
    <div className="mx-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        AI Sensitivity
      </h3>
      <div className="rounded-lg bg-card border border-border p-3">
        <div className="flex rounded-md bg-secondary p-1 gap-1">
          {levels.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => onChangeSensitivity(key)}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-200 ${
                sensitivity === key
                  ? "bg-primary text-primary-foreground glow-pink-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}>
              {label}
            </button>
          ))}
        </div>
        <p className="mt-2.5 text-[11px] text-muted-foreground leading-relaxed">
          {activeLevel.desc}
        </p>
      </div>
    </div>
  );
};

export default SensitivityControl;
