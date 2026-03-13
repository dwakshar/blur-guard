import { Image, Video, Ban } from "lucide-react";

const stats = [
  { icon: Image, label: "Images", value: "847" },
  { icon: Video, label: "Videos", value: "123" },
  { icon: Ban, label: "Blocked", value: "34" },
];

const ProtectionStatus = () => {
  return (
    <div className="mx-4 rounded-lg bg-card border border-border p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="relative">
          <div className="h-2.5 w-2.5 rounded-full bg-success" />
          <div className="absolute inset-0 rounded-full bg-success animate-pulse-glow glow-green" />
        </div>
        <span className="text-sm font-semibold text-foreground">Protection Active</span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {stats.map(({ icon: Icon, label, value }) => (
          <div
            key={label}
            className="flex flex-col items-center rounded-md bg-secondary/60 py-3 px-2 transition-colors hover:bg-secondary"
          >
            <Icon className="h-4 w-4 text-muted-foreground mb-1.5" />
            <span className="text-lg font-bold text-foreground leading-none">{value}</span>
            <span className="text-[10px] text-muted-foreground mt-1">{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ProtectionStatus;
