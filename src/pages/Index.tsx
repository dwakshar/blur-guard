// src/pages/Index.tsx
// Root popup page. Pulls live state from useBlurGuard and distributes
// it to every child component as props — single source of truth.

import DetectionFeed from "@/components/blurguard/DetectionFeed";
import Header from "@/components/blurguard/Header";
import ProtectionStatus from "@/components/blurguard/ProtectionStatus";
import QuickActions from "@/components/blurguard/QuickActions";
import SafetyInsights from "@/components/blurguard/SafetyInsights";
import SensitivityControl from "@/components/blurguard/SensitivityControl";
import { useBlurGuard } from "@/hooks/useBlurGuard";
import { useCallback } from "react";

const Index = () => {
  const { state, loading, resetStats, setEnabled, setPaused, setSensitivity } =
    useBlurGuard();
  const resumeProtection = useCallback(() => {
    setEnabled(true);
  }, [setEnabled]);

  return (
    <div className="min-h-screen flex items-start justify-center bg-background py-8">
      <div className="w-[360px] bg-background border border-border rounded-2xl overflow-hidden shadow-2xl shadow-primary/5">
        {loading ? (
          // Skeleton shimmer while fetching state from background
          <div className="flex items-center justify-center h-[420px]">
            <div className="h-4 w-4 rounded-full bg-primary/40 animate-pulse" />
          </div>
        ) : (
          <div className="space-y-3">
            <Header enabled={state.enabled} />

            <ProtectionStatus stats={state.stats} enabled={state.enabled} />

            <DetectionFeed feed={state.feed} />

            <SensitivityControl
              sensitivity={state.sensitivity}
              onChangeSensitivity={setSensitivity}
            />

            <QuickActions
              enabled={state.enabled}
              pausedUntil={state.pausedUntil}
              onToggleEnabled={() => setEnabled(!state.enabled)}
              onPause={() => setPaused()}
              onResume={resumeProtection}
              onResetStats={resetStats}
            />

            <SafetyInsights stats={state.stats} feed={state.feed} />
          </div>
        )}
      </div>
    </div>
  );
};

export default Index;
