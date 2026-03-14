<div align="center">

<br/>

```
██████╗ ██╗     ██╗   ██╗██████╗  ██████╗ ██╗   ██╗ █████╗ ██████╗ ██████╗
██╔══██╗██║     ██║   ██║██╔══██╗██╔════╝ ██║   ██║██╔══██╗██╔══██╗██╔══██╗
██████╔╝██║     ██║   ██║██████╔╝██║  ███╗██║   ██║███████║██████╔╝██║  ██║
██╔══██╗██║     ██║   ██║██╔══██╗██║   ██║██║   ██║██╔══██║██╔══██╗██║  ██║
██████╔╝███████╗╚██████╔╝██║  ██║╚██████╔╝╚██████╔╝██║  ██║██║  ██║██████╔╝
╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝
```

### **AI-Powered Browser Extension for Real-Time NSFW Detection**

*Bonking NSFW tabs before you see them.*

<br/>

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest_V3-FF1A6B?style=for-the-badge&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge)](LICENSE)

<br/>

---

</div>

<br/>

## ◈ What is BlurGuard?

BlurGuard is a **Chrome browser extension** that silently watches every page you visit and blurs explicit or NSFW images and videos the moment they load — including dynamically injected content from infinite scroll, SPAs, and lazy-loading — before they fully render on your screen.

No more accidental exposure. No more unsafe-for-work surprises while browsing. One install, total control.

> **Three classification engines. One consistent interface. Zero latency compromise.**
>
> Choose between instant URL-pattern heuristics, a custom moderation API, or a fully private on-device TensorFlow.js neural network — all swappable with a single config line.

<br/>

---

<br/>

## ◈ Why BlurGuard?

Most content filters work at the DNS or network layer — they block entire domains. BlurGuard is different. It operates **inside the page**, element by element, in real time.

| Problem | BlurGuard's Approach |
|---|---|
| NSFW content appears before filters catch it | Scans on `document_idle` + watches via `MutationObserver` — nothing slips through |
| Blurring shifts page layout | Wraps elements in dimension-preserving containers — **zero layout shift** |
| Content filters kill legitimate browsing | Three sensitivity tiers — block only what you choose |
| Privacy concerns with cloud classifiers | `tfjs` backend runs **entirely on your device** — no pixel ever leaves your browser |
| You can't access accidentally revealed content | Click-to-reveal — one tap fades the overlay, original media always accessible |
| Popup shows stale data | Background pushes `STATE_UPDATED` live — no polling, no refresh needed |

<br/>

---

<br/>

## ◈ Feature Highlights

<br/>

**Real-time scanning**
Detects `<img>` and `<video>` elements the moment they appear — on load, on scroll, on DOM mutation. Uses a `WeakSet` so no element is ever processed twice and GC can reclaim anything removed from the page.

**Layout-preserving overlay**
Unlike `filter: blur()` which triggers repaints and shifts surrounding elements, BlurGuard wraps flagged elements in a `position: relative` container that mirrors every layout CSS property — margin, flex, border-radius, dimensions — and layers a `backdrop-filter` glass pane on top. The page looks identical. Content is simply covered.

**Click-to-reveal**
A single click fades the overlay to transparent with a 250ms ease transition. Click again to restore. The original media is always accessible — BlurGuard never removes content, only covers it.

**Live popup dashboard**
- Images scanned · Videos scanned · Total blocked — live counters
- Detection feed with domain, confidence %, and relative timestamp
- 7-bar confidence sparkline
- Top detected domains
- Sensitivity toggle (Low / Balanced / Strict) with immediate effect across all open tabs

**Three classifier backends**

```
"pattern"  → Instant  · URL regex · No network · Zero setup
"api"      → ~200ms   · POST to your endpoint · Per-session URL cache
"tfjs"     → ~400ms   · TensorFlow.js + NSFW.js · Fully on-device
```

**Typed Chrome messaging**
All three extension contexts (popup, background service worker, content script) share a single typed contract in `src/types/messages.ts`. No stringly-typed `postMessage`. No guessing at payload shapes.

<br/>

---

<br/>

## ◈ Architecture

BlurGuard runs across three isolated Chrome extension contexts, connected by a fully-typed message bus:

```
┌──────────────────────────────────────────────────────────────────────┐
│                       POPUP  ·  React 19 UI                          │
│                                                                      │
│   ┌────────┐  ┌──────────────────┐  ┌───────────────────────────┐   │
│   │ Header │  │ ProtectionStatus │  │      DetectionFeed        │   │
│   └────────┘  └──────────────────┘  └───────────────────────────┘   │
│   ┌──────────────────┐  ┌──────────────┐  ┌───────────────────┐     │
│   │ SensitivityCtrl  │  │ QuickActions │  │  SafetyInsights   │     │
│   └──────────────────┘  └──────────────┘  └───────────────────┘     │
│                                                                      │
│              ↕  chrome.runtime.sendMessage / onMessage               │
├──────────────────────────────────────────────────────────────────────┤
│              BACKGROUND  ·  MV3 Service Worker                       │
│                                                                      │
│   • Owns BlurGuardState in chrome.storage.local                      │
│   • Handles: GET_STATE · SET_ENABLED · SET_SENSITIVITY               │
│   • REPORT_DETECTION → updates feed[] + stats → pushes STATE_UPDATED │
│   • Broadcasts PROTECTION_TOGGLED / SENSITIVITY_CHANGED to all tabs  │
│                                                                      │
│              ↕  chrome.tabs.sendMessage (broadcast to all tabs)      │
├──────────────────────────────────────────────────────────────────────┤
│              CONTENT SCRIPT  ·  Injected into every tab              │
│                                                                      │
│   ┌──────────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│   │  mediaDetector   │ → │  classifier  │ → │   blurOverlay     │   │
│   │  WeakSet scan    │   │  pattern/api │   │  DOM wrap + glass │   │
│   │  MutationObsvr   │   │  /tfjs       │   │  click-to-reveal  │   │
│   └──────────────────┘   └──────────────┘   └───────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

> **The popup never polls.** Every state change — detection, toggle, sensitivity — triggers a `STATE_UPDATED` push from the background. The UI re-renders in real time with zero latency from polling intervals.

<br/>

---

<br/>

## ◈ Classification Backends

Three interchangeable backends behind one `Classifier` interface. Swap with a single config change in `content.ts`:

```typescript
// Instant URL heuristics — zero setup, works offline
const classifier = createClassifier({ backend: 'pattern', sensitivity: 'balanced' });

// Your own moderation API — full control over the model
const classifier = createClassifier({
  backend: 'api',
  sensitivity: 'strict',
  apiConfig: { endpoint: 'https://your-api.com/moderate', apiKey: 'sk-...' }
});

// On-device neural network — no data leaves the browser
const classifier = createClassifier({
  backend: 'tfjs',
  sensitivity: 'balanced',
  tfjsConfig: { modelUrl: chrome.runtime.getURL('models/nsfwjs/') }
});
```

### Sensitivity thresholds

| Tier | Confidence threshold | Best for |
|---|---|---|
| **Low** | ≥ 0.85 | Near-certain explicit content only |
| **Balanced** | ≥ 0.60 | Everyday browsing — good precision/recall |
| **Strict** | ≥ 0.35 | Flag anything with moderate probability |

### Backend comparison

| | `pattern` | `api` | `tfjs` |
|---|---|---|---|
| Latency | Instant (sync) | ~200ms | ~400ms first run |
| Accuracy | URL-heuristic | Depends on your model | NSFW.js neural net |
| Privacy | Full — no network | URL leaves device | Full — runs on device |
| Setup | None | Endpoint + optional key | Model URL |
| Works offline | Yes | No | Yes (after model load) |
| Caching | N/A | Per-session URL cache | Model cached after load |

<br/>

---

<br/>

## ◈ Message Protocol

All three contexts share a single typed contract. No stringly-typed messages — every type is an exhaustive union, every payload is typed.

```typescript
// src/types/messages.ts — the single source of truth

export type MessageType =
  | 'GET_STATE'           // popup → background
  | 'SET_ENABLED'         // popup → background
  | 'SET_SENSITIVITY'     // popup → background
  | 'REPORT_DETECTION'    // content → background
  | 'PROTECTION_TOGGLED'  // background → all tabs (broadcast)
  | 'SENSITIVITY_CHANGED' // background → all tabs (broadcast)
  | 'STATE_UPDATED';      // background → popup  (push — no polling)
```

| Message | Direction | Payload |
|---|---|---|
| `GET_STATE` | popup → background | — · returns full `BlurGuardState` |
| `SET_ENABLED` | popup → background | `boolean` |
| `SET_SENSITIVITY` | popup → background | `"low" \| "balanced" \| "strict"` |
| `REPORT_DETECTION` | content → background | `{ kind, src, confidence }` |
| `PROTECTION_TOGGLED` | background → all tabs | `boolean` |
| `SENSITIVITY_CHANGED` | background → all tabs | `Sensitivity` |
| `STATE_UPDATED` | background → popup | Full `BlurGuardState` |

<br/>

---

<br/>

## ◈ Project Structure

```
blur-guard/
│
├── public/
│   ├── manifest.json              ← Chrome MV3 manifest · all 3 contexts declared
│   └── icons/                     ← icon16 · icon48 · icon128
│
├── src/
│   ├── background.ts              ← Service worker · state owner · push notifications
│   ├── content.ts                 ← Injected into every tab · scan → classify → blur
│   ├── main.tsx                   ← React 19 popup entry point
│   ├── index.css                  ← Design tokens · glow utilities · custom animations
│   │
│   ├── types/
│   │   └── messages.ts            ← BlurGuardState · DetectionEvent · MessageType union
│   │
│   ├── lib/
│   │   ├── mediaDetector.ts       ← MutationObserver + WeakSet DOM scanner
│   │   ├── blurOverlay.ts         ← Layout-preserving wrapper · click-to-reveal
│   │   └── classifier.ts          ← pattern | api | tfjs abstraction layer
│   │
│   ├── hooks/
│   │   └── useBlurGuard.ts        ← React ↔ background bridge · live STATE_UPDATED
│   │
│   ├── pages/
│   │   └── Index.tsx              ← Popup root · single state owner · prop distribution
│   │
│   └── components/
│       ├── blurguard/
│       │   ├── Header.tsx             ← Logo + AI Active / Paused badge
│       │   ├── ProtectionStatus.tsx   ← Live images · videos · blocked counters
│       │   ├── DetectionFeed.tsx      ← Real-time event list · confidence · timestamps
│       │   ├── SensitivityControl.tsx ← Low · Balanced · Strict toggle
│       │   ├── QuickActions.tsx       ← Enable / Disable protection
│       │   └── SafetyInsights.tsx     ← Sparkline · top domains · avg confidence
│       └── ui/                        ← shadcn/ui primitives (40+ components)
│
├── vite.config.ts                 ← Multi-entry build · flat dist/ for Chrome
├── tsconfig.app.json              ← types:["chrome"] · @/* path alias · strict
└── postcss.config.js              ← Tailwind PostCSS integration
```

<br/>

---

<br/>

## ◈ Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **Chrome** ≥ 120 (Manifest V3)
- **VS Code** recommended

### Install & build

```bash
# 1. Clone
git clone https://github.com/dwakshar/blur-guard.git
cd blur-guard

# 2. Install dependencies
npm install

# 3. Build
npm run build
# → generates dist/ with background.js, content.js, index.html
```

### Load in Chrome

```
1. Open  chrome://extensions
2. Toggle  Developer Mode  (top-right)
3. Click  Load unpacked
4. Select the  dist/  folder
5. BlurGuard icon appears in your toolbar — you're live
```

### Development workflow

```bash
# Rebuild on every file save
npx vite build --watch

# After each rebuild, refresh the extension:
# chrome://extensions → click ↺ on BlurGuard
```

> **Important:** Never test by running `npm run dev`. The Vite dev server uses `eval` for HMR, which Chrome's Content Security Policy blocks. Always load from `dist/`.

<br/>

---

<br/>

## ◈ How the Blur Overlay Works (No Layout Shift)

Applying `filter: blur()` directly to an image causes a repaint that can collapse or shift the surrounding layout. BlurGuard avoids this entirely:

```
Before BlurGuard:                 After BlurGuard:

┌─────────────────┐               ┌─────────────────┐  ← wrapper div
│                 │               │   <img>          │    exact same size + position
│   <img src=X>   │      →        │                  │    as original element
│                 │               │  ───────────────  │
└─────────────────┘               │  🛡 BlurGuard    │  ← position:absolute, inset:0
                                  │  backdrop-filter  │    backdrop-filter: blur(22px)
                                  └─────────────────┘
```

**Step by step:**
1. Capture `offsetWidth`, `offsetHeight`, and all layout CSS from the original element
2. Create a `position: relative` wrapper with **identical** dimensions, margin, flex properties, and border-radius
3. Swap the element for the wrapper in the DOM (no reflow)
4. Move the element inside the wrapper (fills 100%)
5. Append an absolutely-positioned glass pane with `backdrop-filter: blur()`

Result: **zero layout shift.** Surrounding elements never move. The page structure is preserved exactly.

<br/>

---

<br/>

## ◈ Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension platform | Chrome MV3 | The only supported format going forward |
| Language | TypeScript 5.8 | Shared types across 3 isolated contexts |
| UI framework | React 19 | Popup UI + composition |
| Styling | Tailwind CSS | Design tokens · utility classes · custom glow utilities |
| Build tool | Vite 7 | Multi-entry rollup · flat output required by Chrome |
| UI components | shadcn/ui | Accessible · unstyled · composable |
| Classification | NSFW.js + TensorFlow.js | On-device inference — no API key required |
| State | chrome.storage.local | Survives service worker sleep/wake cycles |
| Icons | lucide-react | Tree-shakeable · consistent stroke width |

<br/>

---

<br/>

## ◈ Privacy

BlurGuard does not collect analytics, telemetry, or usage data of any kind.

| Backend | What leaves your browser | Storage |
|---|---|---|
| `pattern` | Nothing — regex runs locally | No external storage |
| `api` | Image URLs only (not pixel data) | Your own endpoint |
| `tfjs` | Nothing — model runs in-browser | `chrome.storage.local` only |

All detection history, counters, and settings are stored exclusively in `chrome.storage.local` — local to your browser profile, never synced or transmitted.

<br/>

---

<br/>

## ◈ Roadmap

- [ ] **Allowlist** — per-domain opt-out for trusted sites
- [ ] **Pause timer** — "Pause for 5 minutes" with live countdown in popup
- [ ] **Custom model** — drop-in ONNX / TFLite model support
- [ ] **Firefox support** — port to WebExtensions API (MV2 compatible)
- [ ] **Statistics export** — download detection history as CSV
- [ ] **WXT migration** — replace custom Vite config with proper extension tooling

<br/>

---

<br/>

## ◈ Contributing

Pull requests are welcome. For significant changes, please open an issue first.

```bash
# Type check
npx tsc --noEmit

# Lint
npm run lint

# Test
npm run test
```

TypeScript must pass with zero errors before any PR is merged.

<br/>

---

<br/>

## ◈ License

[MIT](LICENSE) © [dwakshar](https://github.com/dwakshar)

<br/>

---

<div align="center">

<br/>

Built with TypeScript · React 19 · Chrome MV3 · TensorFlow.js

<br/>

*Bonking NSFW tabs before you see them.*

<br/>

**[⭐ Star this repo](https://github.com/dwakshar/blur-guard)** if BlurGuard saved your day

</div>
