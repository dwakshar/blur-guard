import { Shield } from "lucide-react";

const Header = () => {
  return (
    <div className="px-4 pt-5 pb-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="relative">
            <Shield className="h-7 w-7 text-primary" strokeWidth={2.5} />
            <div className="absolute inset-0 blur-md bg-primary/30 rounded-full" />
          </div>
          <span className="text-lg font-bold tracking-tight text-foreground">
            Blur<span className="text-primary">Guard</span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 rounded-full bg-success/10 border border-success/20 px-2.5 py-1">
          <div className="h-1.5 w-1.5 rounded-full bg-success animate-pulse-glow" />
          <span className="text-[10px] font-medium text-success">AI Active</span>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
        Bonking NSFW tabs before you see them.
      </p>
      <div className="mt-3 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />
    </div>
  );
};

export default Header;
