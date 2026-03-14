<div align="center">

<img src="banner.jpg" width=100%>

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest_V3-FF1A6B?style=flat-square&logo=googlechrome&logoColor=white)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](#)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](#)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](#)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](#)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](#license)

</div>

AI-Powered Browser Extension for Real-Time NSFW Detection. Bonking NSFW tabs before you see them.

---

## The Problem It Solves

NSFW content appears before filters catch it. DNS-level blockers kill entire domains. CSS blur shifts your layout. Cloud classifiers send your data to someone else's server. And once something is revealed, there's no way to cover it again.

BlurGuard operates **inside the page**, element by element, in real time — before anything renders. It scans on `document_idle`, watches via `MutationObserver` for anything injected later, wraps every flagged element in a dimension-preserving container with zero layout shift, and pushes live state to the popup with no polling.

---

## What It Does

```
╔══════════════════════════════════════════════════════════════════════════════╗
║                     THREE ENGINES, ONE CONSISTENT INTERFACE                  ║
╠══════════════════╦═══════════════════════════╦════════════════════════════╗  ║
║  MEDIA DETECTOR  ║   CLASSIFIER              ║   BLUR OVERLAY             ║  ║
║  ─────────────── ║   ──────────              ║   ───────────              ║  ║
║  <img> + <video> ║  "pattern" → instant      ║  position:relative wrap    ║  ║
║  MutationObsvr   ║  URL regex · zero setup   ║  mirrors all layout CSS    ║  ║
║  WeakSet dedup   ║                           ║  zero layout shift         ║  ║
║                  ║  "api" → ~200ms           ║  backdrop-filter glass     ║  ║
║  Initial scan    ║  POST to your endpoint    ║  pane on top               ║  ║
║  + dynamic adds  ║  per-session URL cache    ║  click-to-reveal           ║  ║
║                  ║                           ║  250ms ease transition     ║  ║
║                  ║  "tfjs" → ~400ms          ║                            ║  ║
║                  ║  TensorFlow.js + NSFW.js  ║                            ║  ║
║                  ║  fully on-device          ║                            ║  ║
╠══════════════════╩═══════════════════════════╩════════════════════════════╣  ║
║  LIVE POPUP DASHBOARD                                                     ║  ║
║  ────────────────────                                                     ║  ║
║  Images scanned · Videos scanned · Total blocked — live counters          ║  ║
║  Detection feed · domain · confidence % · relative timestamp              ║  ║
║  7-bar confidence sparkline · Top detected domains · Sensitivity toggle   ║  ║
╚═══════════════════════════════════════════════════════════════════════════╚══╝
```

---

## How It Works

Three isolated Chrome extension contexts connected by a fully-typed message bus. The popup never polls — every state change triggers a `STATE_UPDATED` push from the background.

```
 ┌────────────────────────────────────────────────────────────────────────┐
 │  POPUP  ·  React 19 UI                                                 │
 │                                                                        │
 │  ┌────────┐  ┌──────────────────┐  ┌───────────────────────────────┐   │
 │  │ Header │  │ ProtectionStatus │  │        DetectionFeed          │   │
 │  └────────┘  └──────────────────┘  └───────────────────────────────┘   │
 │  ┌──────────────────┐  ┌──────────────┐  ┌───────────────────────┐     │
 │  │ SensitivityCtrl  │  │ QuickActions │  │    SafetyInsights     │     │
 │  └──────────────────┘  └──────────────┘  └───────────────────────┘     │
 └───────────────────────────── │ ────────────────────────────────────────┘
               chrome.runtime.sendMessage / onMessage
 ┌───────────────────────────── │ ────────────────────────────────────────┐
 │  BACKGROUND  ·  MV3 Service Worker          ◄────────────────────────  │
 │                                                                        │
 │  • Owns BlurGuardState in chrome.storage.local                         │
 │  • Handles: GET_STATE · SET_ENABLED · SET_SENSITIVITY                  │
 │  • REPORT_DETECTION → updates feed[] + stats → pushes STATE_UPDATED    │
 │  • Broadcasts PROTECTION_TOGGLED / SENSITIVITY_CHANGED to all tabs     │
 └───────────────────────────── │ ────────────────────────────────────────┘
           chrome.tabs.sendMessage (broadcast to all tabs)
 ┌───────────────────────────── │ ────────────────────────────────────────┐
 │  CONTENT SCRIPT  ·  Injected into every tab   ◄──────────────────────  │
 │                                                                        │
 │  ┌──────────────────┐   ┌──────────────┐   ┌───────────────────────┐   │
 │  │  mediaDetector   │ → │  classifier  │ → │     blurOverlay       │   │
 │  │  WeakSet scan    │   │  pattern/api │   │  DOM wrap + glass     │   │
 │  │  MutationObsvr   │   │  /tfjs       │   │  click-to-reveal      │   │
 │  └──────────────────┘   └──────────────┘   └───────────────────────┘   │
 └────────────────────────────────────────────────────────────────────────┘
```

### Why chrome.storage, Not Module Variables

MV3 service workers are killed after ~30 seconds of inactivity. BlurGuard survives by persisting **all** state to `chrome.storage.local` — never module-level variables — and re-hydrating on every `GET_STATE` request. Every detection, counter, and setting is durable across sleep/wake cycles.

---

## The Classifier

Three interchangeable backends behind one `Classifier` interface. Swap with a single config change in `content.ts`:

```typescript
// Instant URL heuristics — zero setup, works offline
const classifier = createClassifier({
  backend: "pattern",
  sensitivity: "balanced",
});

// Your own moderation API — full control over the model
const classifier = createClassifier({
  backend: "api",
  sensitivity: "strict",
  apiConfig: { endpoint: "https://your-api.com/moderate", apiKey: "sk-..." },
});

// On-device neural network — no data leaves the browser
const classifier = createClassifier({
  backend: "tfjs",
  sensitivity: "balanced",
  tfjsConfig: { modelUrl: chrome.runtime.getURL("models/nsfwjs/") },
});
```

```
SENSITIVITY THRESHOLDS
────────────────────────────────────────────────────────────────
[LOW]       ── confidence ≥ 0.85
  • Near-certain explicit content only

[BALANCED]  ── confidence ≥ 0.60
  • Everyday browsing — good precision/recall trade-off

[STRICT]    ── confidence ≥ 0.35
  • Flag anything with moderate probability
────────────────────────────────────────────────────────────────
Threshold checked after every classify() call.
Sensitivity changes broadcast immediately to all open tabs.
```

---

## Backend Comparison

|               | `pattern`         | `api`                   | `tfjs`                  |
| ------------- | ----------------- | ----------------------- | ----------------------- |
| Latency       | Instant (sync)    | ~200ms                  | ~400ms first run        |
| Accuracy      | URL-heuristic     | Depends on your model   | NSFW.js neural net      |
| Privacy       | Full — no network | URL leaves device       | Full — runs on device   |
| Setup         | None              | Endpoint + optional key | Model URL               |
| Works offline | Yes               | No                      | Yes (after model load)  |
| Caching       | N/A               | Per-session URL cache   | Model cached after load |

---

## How the Blur Overlay Works (No Layout Shift)

Applying `filter: blur()` directly to an image causes a repaint that shifts surrounding elements. BlurGuard avoids this entirely:

```
Before BlurGuard:                 After BlurGuard:

┌─────────────────┐               ┌─────────────────┐  ← wrapper div
│                 │               │   <img>         │    exact same size + position
│   <img src=X>   │      →        │                 │    as original element
│                 │               │─────────────────│
└─────────────────┘               │  🛡 BlurGuard       ← position:absolute, inset:0
                                  │  backdrop-filter│    backdrop-filter: blur(22px)
                                  └─────────────────┘
```

Step by step:

1. Capture `offsetWidth`, `offsetHeight`, and all layout CSS from the original element
2. Create a `position: relative` wrapper with **identical** dimensions, margin, flex properties, and border-radius
3. Swap the element for the wrapper in the DOM (no reflow)
4. Move the element inside the wrapper (fills 100%)
5. Append an absolutely-positioned glass pane with `backdrop-filter: blur()`

Result: **zero layout shift.** Surrounding elements never move.

---

## Message Protocol

All three contexts share a single typed contract. No stringly-typed messages — every type is an exhaustive union, every payload is typed.

```typescript
// src/types/messages.ts — the single source of truth

export type MessageType =
  | "GET_STATE" // popup → background
  | "SET_ENABLED" // popup → background
  | "SET_SENSITIVITY" // popup → background
  | "REPORT_DETECTION" // content → background
  | "PROTECTION_TOGGLED" // background → all tabs (broadcast)
  | "SENSITIVITY_CHANGED" // background → all tabs (broadcast)
  | "STATE_UPDATED"; // background → popup  (push — no polling)
```

| Message               | Direction             | Payload                           |
| --------------------- | --------------------- | --------------------------------- |
| `GET_STATE`           | popup → background    | — · returns full `BlurGuardState` |
| `SET_ENABLED`         | popup → background    | `boolean`                         |
| `SET_SENSITIVITY`     | popup → background    | `"low" \| "balanced" \| "strict"` |
| `REPORT_DETECTION`    | content → background  | `{ kind, src, confidence }`       |
| `PROTECTION_TOGGLED`  | background → all tabs | `boolean`                         |
| `SENSITIVITY_CHANGED` | background → all tabs | `Sensitivity`                     |
| `STATE_UPDATED`       | background → popup    | full `BlurGuardState`             |

---

## Repository Structure

```
blur-guard/
│
├── public/
│   ├── manifest.json              MV3 manifest · popup · SW · content script
│   └── icons/                     icon16.png · icon48.png · icon128.png
│
├── index.html                     popup HTML · MV3-compliant CSP
├── vite.config.ts                 multi-entry build · flat dist/ for Chrome
├── tsconfig.app.json              types:["chrome"] · @/* path alias · strict
├── tsconfig.node.json             types:["node"] for vite.config.ts
└── postcss.config.js              @tailwindcss/postcss integration
│
└── src/
    │
    ├── background.ts              SW hub · chrome.storage owner · STATE_UPDATED push
    ├── content.ts                 injected into every tab · scan → classify → blur
    ├── main.tsx                   React 19 popup entry point
    ├── index.css                  design tokens · glow utilities · custom animations
    │
    ├── types/
    │   └── messages.ts            BlurGuardState · DetectionEvent · MessageType union
    │
    ├── lib/
    │   ├── mediaDetector.ts       MutationObserver + WeakSet DOM scanner
    │   ├── blurOverlay.ts         layout-preserving wrapper · click-to-reveal
    │   └── classifier.ts          pattern | api | tfjs abstraction layer
    │
    ├── hooks/
    │   └── useBlurGuard.ts        React ↔ background bridge · live STATE_UPDATED
    │
    ├── pages/
    │   └── Index.tsx              popup root · single state owner · prop distribution
    │
    └── components/
        ├── blurguard/
        │   ├── Header.tsx             logo + AI Active / Paused badge
        │   ├── ProtectionStatus.tsx   live images · videos · blocked counters
        │   ├── DetectionFeed.tsx      real-time event list · confidence · timestamps
        │   ├── SensitivityControl.tsx low · balanced · strict toggle
        │   ├── QuickActions.tsx       enable / disable protection
        │   └── SafetyInsights.tsx     sparkline · top domains · avg confidence
        └── ui/                        shadcn/ui primitives (40+ components)
```

---

## Getting Started

### Requirements

|         | Minimum |
| ------- | ------- |
| Node.js | 18      |
| npm     | 9       |
| Chrome  | 120     |

### Install and Build

```bash
git clone https://github.com/dwakshar/blur-guard.git
cd blur-guard

npm install
npm run build
# → dist/ folder created with background.js, content.js, index.html
```

### Load into Chrome

```
1.  chrome://extensions
2.  Enable "Developer mode"  (toggle, top right)
3.  Click "Load unpacked" → select the dist/ folder
4.  BlurGuard icon appears in your toolbar — you're live
```

### Development Workflow

```bash
# Terminal 1 — keep running
npx vite build --watch

# Edit any .ts file and save
# → Vite rebuilds in ~1s

# In Chrome → chrome://extensions → click ↺ refresh icon on BlurGuard
```

**Important:** Never test by running `npm run dev`. The Vite dev server uses `eval` for HMR, which Chrome's Content Security Policy blocks. Always load from `dist/`.

---

## All Commands

```bash
npm run build            # development build
npx vite build --watch   # rebuild on every .ts save
npx tsc --noEmit         # TypeScript validation, no output emitted
npm run lint             # eslint across src/
npm run test             # Vitest suite
```

---

## Privacy

BlurGuard does not collect analytics, telemetry, or usage data of any kind.

| Backend   | What leaves your browser         | Storage                     |
| --------- | -------------------------------- | --------------------------- |
| `pattern` | Nothing — regex runs locally     | No external storage         |
| `api`     | Image URLs only (not pixel data) | Your own endpoint           |
| `tfjs`    | Nothing — model runs in-browser  | `chrome.storage.local` only |

All detection history, counters, and settings are stored exclusively in `chrome.storage.local` — local to your browser profile, never synced or transmitted.

---

## Permissions

```jsonc
"permissions": [
  "storage",     // persist BlurGuardState across SW restarts
  "activeTab",   // identify the active tab
  "scripting",   // inject content script into pages
  "tabs"         // broadcast messages to all open tabs
]
```

---

## Tech Stack

| Layer              | Choice                  | Reason                                                  |
| ------------------ | ----------------------- | ------------------------------------------------------- |
| Extension platform | Chrome MV3              | The only supported format going forward                 |
| Language           | TypeScript 5.8          | Shared types across 3 isolated contexts                 |
| UI framework       | React 19                | Popup UI + composition                                  |
| Styling            | Tailwind CSS v4         | Design tokens · utility classes · custom glow utilities |
| Build tool         | Vite 7                  | Multi-entry rollup · flat output required by Chrome     |
| UI components      | shadcn/ui               | Accessible · unstyled · composable                      |
| Classification     | NSFW.js + TensorFlow.js | On-device inference — no API key required               |
| State              | chrome.storage.local    | Survives service worker sleep/wake cycles               |
| Icons              | lucide-react            | Tree-shakeable · consistent stroke width                |

---

## Roadmap

- [ ] Allowlist — per-domain opt-out for trusted sites
- [ ] Pause timer — "Pause for 5 minutes" with live countdown in popup
- [ ] Custom model — drop-in ONNX / TFLite model support
- [ ] Firefox support — port to WebExtensions API (MV2 compatible)
- [ ] Statistics export — download detection history as CSV
- [ ] WXT migration — replace custom Vite config with proper extension tooling

---

## Contributing

```bash
git checkout -b feature/your-thing

# New classification logic → src/lib/classifier.ts (pure functions, no Chrome knowledge needed)
# New overlay behaviour   → src/lib/blurOverlay.ts
# New popup components    → src/components/blurguard/
npm run test

# Verify in Chrome
npm run build

# PR: describe which media signal you're consuming and what it detects
```

TypeScript must pass with zero errors before any PR is merged.

```bash
npx tsc --noEmit
npm run lint
```

---

## License

MIT — see [LICENSE](./LICENSE)

---

<div align="center">

<br/>

```
  built with  chrome.runtime  ·  typescript  ·  react 19  ·  obsessive attention to layout
```

_If BlurGuard saved your day, a ⭐ means a lot:)._

<br/>

</div>
