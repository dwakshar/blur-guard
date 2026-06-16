// src/components/blurguard/ApiBackendControl.tsx
// Lets the user opt in to the Sightengine cloud API backend.
//
// Privacy contract (shown verbatim in the consent panel):
//   On-device (default): every image is classified entirely inside the browser.
//   No pixels, no URLs, and no data of any kind leave your device.
//
//   Cloud API (Sightengine): while enabled, the image data (raw pixels) of every
//   image on pages you visit is sent to Sightengine's servers for analysis.
//   This covers your continuous browsing stream — not a one-off action.
//   Your api_user and api_secret authenticate each request and are stored
//   locally in extension storage only — never transmitted elsewhere.

import { useState, useRef } from "react";
import { Cloud, Cpu, Eye, EyeOff, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApiBackend, SightengineConfig } from "@/types/messages";

interface Props {
  apiBackend: ApiBackend;
  apiConfig: SightengineConfig | null;
  onSetApiBackend: (b: ApiBackend) => void;
  onSetApiConfig: (c: SightengineConfig) => void;
}

const ApiBackendControl = ({ apiBackend, apiConfig, onSetApiBackend, onSetApiConfig }: Props) => {
  const [pendingCloud, setPendingCloud] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [apiUser, setApiUser] = useState(apiConfig?.apiUser ?? "");
  const [apiSecret, setApiSecret] = useState(apiConfig?.apiSecret ?? "");
  const [dirty, setDirty] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  const isCloud = apiBackend === "sightengine";
  const hasCreds = !!apiConfig?.apiUser && !!apiConfig?.apiSecret;

  function handleSelectCloud() {
    if (isCloud) return;
    setPendingCloud(true);
    // Focus the first credential field once the panel slides in
    setTimeout(() => userRef.current?.focus(), 50);
  }

  function handleConfirmCloud() {
    const trimUser = apiUser.trim();
    const trimSecret = apiSecret.trim();
    if (!trimUser || !trimSecret) return;
    onSetApiConfig({ apiUser: trimUser, apiSecret: trimSecret });
    onSetApiBackend("sightengine");
    setPendingCloud(false);
    setDirty(false);
  }

  function handleCancelCloud() {
    setPendingCloud(false);
    setApiUser(apiConfig?.apiUser ?? "");
    setApiSecret(apiConfig?.apiSecret ?? "");
    setDirty(false);
  }

  function handleSwitchToOnDevice() {
    onSetApiBackend("tfjs");
    setPendingCloud(false);
  }

  const inputClass =
    "w-full rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px]" +
    " text-foreground placeholder:text-muted-foreground/50 font-mono" +
    " focus:outline-none focus:ring-1 focus:ring-primary/60";

  return (
    <div className="mx-4">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        Classification Engine
      </h3>

      <div className="rounded-lg bg-card border border-border p-3 space-y-3">
        {/* Backend toggle */}
        <div className="flex rounded-md bg-secondary p-1 gap-1">
          <button
            onClick={handleSwitchToOnDevice}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-200 flex items-center justify-center gap-1.5 ${
              !isCloud && !pendingCloud
                ? "bg-primary text-primary-foreground glow-pink-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}>
            <Cpu className="h-3 w-3" />
            On-device
          </button>
          <button
            onClick={handleSelectCloud}
            className={`flex-1 rounded-md py-1.5 text-xs font-medium transition-all duration-200 flex items-center justify-center gap-1.5 ${
              isCloud || pendingCloud
                ? "bg-primary text-primary-foreground glow-pink-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}>
            <Cloud className="h-3 w-3" />
            Cloud API
          </button>
        </div>

        {/* On-device description (no consent needed) */}
        {!isCloud && !pendingCloud && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Everything runs in your browser. No URLs, no pixels, no data of any kind
            leave your device.
          </p>
        )}

        {/* Consent + credential panel — shown when pending or already on cloud */}
        {(isCloud || pendingCloud) && (
          <div className="space-y-3">
            {/* Privacy warning — non-negotiable, always visible */}
            <div className="flex gap-2 rounded-md border border-amber-500/30 bg-amber-500/8 p-2.5">
              <TriangleAlert className="h-3.5 w-3.5 text-amber-400 mt-0.5 shrink-0" />
              <p className="text-[11px] text-amber-300/90 leading-relaxed">
                <span className="font-semibold text-amber-300">Data sent while Cloud mode is on:</span>
                {" "}the image data (raw pixels) of every picture on pages you browse
                is sent to Sightengine's servers for analysis. This applies continuously
                to your browsing session — not just once. Your{" "}
                <span className="font-mono">api_user</span> and{" "}
                <span className="font-mono">api_secret</span> authenticate each request
                and are stored locally in extension storage only.
              </p>
            </div>

            {/* Credential fields */}
            <div className="space-y-2">
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1 font-medium uppercase tracking-wide">
                  API User
                </label>
                <input
                  ref={userRef}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="your_api_user"
                  value={apiUser}
                  onChange={(e) => { setApiUser(e.target.value); setDirty(true); }}
                  className={inputClass}
                />
              </div>
              <div>
                <label className="block text-[10px] text-muted-foreground mb-1 font-medium uppercase tracking-wide">
                  API Secret
                </label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="your_api_secret"
                    value={apiSecret}
                    onChange={(e) => { setApiSecret(e.target.value); setDirty(true); }}
                    className={inputClass + " pr-8"}
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
                    {showSecret
                      ? <EyeOff className="h-3 w-3" />
                      : <Eye className="h-3 w-3" />
                    }
                  </button>
                </div>
              </div>
            </div>

            {/* Active status or confirm/cancel buttons */}
            {isCloud && !dirty ? (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {hasCreds
                    ? <span className="text-success font-medium">✓ Credentials saved</span>
                    : <span className="text-destructive font-medium">⚠ Credentials missing</span>
                  }
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDirty(true)}
                  className="h-7 text-[11px] border-border hover:bg-secondary">
                  Edit
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={handleConfirmCloud}
                  disabled={!apiUser.trim() || !apiSecret.trim()}
                  className="flex-1 h-7 text-[11px] font-semibold bg-primary text-primary-foreground glow-pink-sm">
                  Save & enable
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancelCloud}
                  className="flex-1 h-7 text-[11px] border-border hover:bg-secondary">
                  Cancel
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ApiBackendControl;
