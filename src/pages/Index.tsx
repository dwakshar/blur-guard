// src/pages/Index.tsx
// Root popup page. Pulls live state from useBlurGuard and distributes
// it to every child component as props — single source of truth.

import AllowlistControl from "@/components/blurguard/AllowlistControl";
import ApiBackendControl from "@/components/blurguard/ApiBackendControl";
import DetectionFeed from "@/components/blurguard/DetectionFeed";
import Header from "@/components/blurguard/Header";
import ProtectionStatus from "@/components/blurguard/ProtectionStatus";
import QuickActions from "@/components/blurguard/QuickActions";
import SafetyInsights from "@/components/blurguard/SafetyInsights";
import SensitivityControl from "@/components/blurguard/SensitivityControl";
import { useBlurGuard } from "@/hooks/useBlurGuard";
import { useCallback } from "react";

const Index = () => {
  const {
    state, loading, activeDomain, resetStats, setEnabled, setPaused, setSensitivity,
    setApiBackend, setApiConfig, apiConfig, addAllowlistDomain, removeAllowlistDomain,
  } = useBlurGuard();
  const resumeProtection = useCallback(() => {
    setEnabled(true);
  }, [setEnabled]);

  return (
    <div className="w-full bg-background select-none">
      <div className="w-[360px] max-w-full overflow-hidden rounded-[26px] bg-background shadow-[0_24px_60px_rgba(0,0,0,0.38)]">
        {loading ? (
          // Skeleton shimmer while fetching state from background
          <div className="flex items-center justify-center h-[420px]">
            <div className="h-4 w-4 rounded-full bg-primary/40 animate-pulse" />
          </div>
        ) : (
          <div className="space-y-3 py-1">
            <Header enabled={state.enabled} />

            <ProtectionStatus stats={state.stats} enabled={state.enabled} cloudWarning={state.cloudWarning} />

            <DetectionFeed feed={state.feed} />

            <SensitivityControl
              sensitivity={state.sensitivity}
              onChangeSensitivity={setSensitivity}
            />

            <ApiBackendControl
              apiBackend={state.apiBackend}
              apiConfig={apiConfig}
              onSetApiBackend={setApiBackend}
              onSetApiConfig={setApiConfig}
            />

            <QuickActions
              enabled={state.enabled}
              pausedUntil={state.pausedUntil}
              onToggleEnabled={() => setEnabled(!state.enabled)}
              onPause={() => setPaused()}
              onResume={resumeProtection}
              onResetStats={resetStats}
            />

            <AllowlistControl
              allowlist={state.allowlist}
              activeDomain={activeDomain}
              onAdd={addAllowlistDomain}
              onRemove={removeAllowlistDomain}
            />

            <SafetyInsights stats={state.stats} feed={state.feed} />
          </div>
        )}
      </div>
    </div>
  );
};

export default Index;
