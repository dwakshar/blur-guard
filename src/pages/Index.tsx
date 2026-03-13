import Header from "@/components/blurguard/Header";
import ProtectionStatus from "@/components/blurguard/ProtectionStatus";
import DetectionFeed from "@/components/blurguard/DetectionFeed";
import SensitivityControl from "@/components/blurguard/SensitivityControl";
import QuickActions from "@/components/blurguard/QuickActions";
import SafetyInsights from "@/components/blurguard/SafetyInsights";

const Index = () => {
  return (
    <div className="min-h-screen flex items-start justify-center bg-background py-8">
      <div className="w-[360px] bg-background border border-border rounded-2xl overflow-hidden shadow-2xl shadow-primary/5">
        <div className="space-y-3">
          <Header />
          <ProtectionStatus />
          <DetectionFeed />
          <SensitivityControl />
          <QuickActions />
          <SafetyInsights />
        </div>
      </div>
    </div>
  );
};

export default Index;
