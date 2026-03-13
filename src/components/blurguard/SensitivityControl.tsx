import { useState } from "react";

const levels = [
  { key: "low", label: "Low", desc: "Only blocks highly explicit content." },
  { key: "balanced", label: "Balanced", desc: "Smart filtering for most situations." },
  { key: "strict", label: "Strict", desc: "Aggressively blocks anything suggestive." },
] as const;

type Level = (typeof levels)[number]["key"];

const SensitivityControl = () => {
  const [active, setActive] = useState<Level>("balanced");
  const activeLevel = levels.find((l) => l.key === active)!;

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
              onClick={() => setActive(key)}
              className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-200 ${
                active === key
                  ? "bg-primary text-primary-foreground glow-pink-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
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
