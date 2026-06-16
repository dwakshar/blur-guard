// Feature flags for BlurGuard.
//
// __CLOUD_ENABLED__ is injected by Vite's `define` at build time (vite.config.ts).
// When false (v1 default), Rollup dead-code-eliminates every branch it guards —
// the Sightengine module is completely absent from the production bundle.
// Flip to true in vite.config.ts for v1.1 to re-enable the cloud backend.
export const CLOUD_BACKEND_ENABLED: boolean = __CLOUD_ENABLED__;
