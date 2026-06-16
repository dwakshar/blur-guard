// src/components/blurguard/AllowlistControl.tsx
// "Disable on this site" toggle + managed allowlist for the popup.

import { Globe, ShieldCheck, ShieldOff, X } from "lucide-react";

interface Props {
  allowlist: string[];
  activeDomain: string | null;
  onAdd: (domain: string) => void;
  onRemove: (domain: string) => void;
}

const AllowlistControl = ({ allowlist, activeDomain, onAdd, onRemove }: Props) => {
  const isAllowlisted = activeDomain ? allowlist.includes(activeDomain) : false;
  const otherEntries = allowlist.filter((d) => d !== activeDomain);

  return (
    <div className="mx-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Site Allowlist
      </h3>

      <div className="rounded-lg bg-card border border-border p-3 space-y-2">
        {/* Active-tab toggle */}
        {activeDomain ? (
          <div className="flex items-center gap-2">
            <Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] text-foreground truncate min-w-0 flex-1 font-mono">
              {activeDomain}
            </span>
            <button
              onClick={() => isAllowlisted ? onRemove(activeDomain) : onAdd(activeDomain)}
              className={`shrink-0 flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all duration-200 border ${
                isAllowlisted
                  ? "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                  : "bg-secondary border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80"
              }`}>
              {isAllowlisted ? (
                <>
                  <ShieldCheck className="h-3 w-3" />
                  Allowed
                </>
              ) : (
                <>
                  <ShieldOff className="h-3 w-3" />
                  Disable here
                </>
              )}
            </button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Open a web page to disable BlurGuard on that site.
          </p>
        )}

        {/* Managed list — entries other than the active domain */}
        {otherEntries.length > 0 && (
          <div className="border-t border-border pt-2 space-y-1">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-1.5">
              Other allowlisted sites
            </p>
            {otherEntries.map((domain) => (
              <div
                key={domain}
                className="flex items-center gap-2 rounded-md bg-secondary/50 px-2 py-1.5">
                <span className="text-[11px] text-foreground font-mono truncate flex-1 min-w-0">
                  {domain}
                </span>
                <button
                  onClick={() => onRemove(domain)}
                  title={`Remove ${domain} from allowlist`}
                  className="shrink-0 text-muted-foreground hover:text-destructive transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Active domain is in list, but there are no other entries → show a hint */}
        {isAllowlisted && otherEntries.length === 0 && (
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            BlurGuard won't scan images on this site. Click "Allowed" to re-enable.
          </p>
        )}
      </div>
    </div>
  );
};

export default AllowlistControl;
