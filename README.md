<div align="center">

<img src="public/icons/icon128.png" alt="BlurGuard Logo" width="80" height="80" />

# BlurGuard

### AI-Powered Browser Extension for Real-Time NSFW Detection

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-FF1A6B?style=flat-square&logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-06B6D4?style=flat-square&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Vite](https://img.shields.io/badge/Vite-7-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![License: MIT](https://img.shields.io/badge/License-MIT-22C55E?style=flat-square)](LICENSE)

<br/>

**Bonking NSFW tabs before you see them.**

Detects and blurs explicit images and videos on any webpage in real time —  
using URL pattern heuristics, external moderation APIs, or a fully private  
on-device TensorFlow.js neural network. Zero data leaves your browser unless you choose otherwise.

<br/>

---

</div>

<br/>

## ✦ What it does

BlurGuard runs silently in the background of every tab. The moment an image or video is loaded — including dynamically injected content from infinite scroll, SPAs, or lazy-loading — it is scanned, classified, and blurred before it fully renders on screen.

- **Real-time** — scans on page load and watches for new elements via `MutationObserver`  
- **Layout-preserving** — blur overlays wrap elements without shifting surrounding content  
- **Click-to-reveal** — one click fades the overlay; original media is always accessible  
- **Live popup** — scanned counts, blocked totals, and a detection feed update instantly in the extension popup as detections happen in any tab  
- **Three sensitivity tiers** — Low / Balanced / Strict, adjustable from the popup with immediate effect across all open tabs

<br/>

## ✦ Demo

> _Load the extension, open any image-heavy page, and watch the popup counters climb._

| Popup UI | Detection Feed | Blur Overlay |
|---|---|---|
| Live stats — images scanned, videos scanned, total blocked | Per-detection events with domain, confidence %, and relative timestamp | Glass overlay with shield icon. Click anywhere to reveal. |

<br/>

## ✦ Architecture

BlurGuard runs across three isolated Chrome extension contexts that communicate over a fully typed message bus:

```
┌─────────────────────────────────────────────────────────────────┐
│                         POPUP  (React UI)                       │
│  Header · ProtectionStatus · DetectionFeed · SensitivityControl │
│  QuickActions · SafetyInsights                                  │
│                  ↕  chrome.runtime.sendMessage                  │
├─────────────────────────────────────────────────────────────────┤
│               BACKGROUND SERVICE WORKER  (MV3 SW)               │
│  Owns BlurGuardState in chrome.storage.local                    │
│  Handles: GET_STATE · SET_ENABLED · SET_SENSITIVITY             │
│           REPORT_DETECTION → pushes STATE_UPDATED to popup      │
│                  ↕  chrome.tabs.sendMessage (broadcast)         │
├─────────────────────────────────────────────────────────────────┤
│            CONTENT SCRIPT  (injected into every tab)            │
│  Step 2: mediaDetector  →  MutationObserver + WeakSet           │
│  Step 3: blurOverlay    →  DOM wrapper, no layout shift         │
│  Step 4: classifier     →  pattern | api | tfjs backends        │
└─────────────────────────────────────────────────────────────────┘
```

The popup never polls. The background pushes a `STATE_UPDATED` message every time state changes, so the UI re-renders in real time.

<br/>

## ✦ Classification Backends

Three interchangeable backends — swap via `createClassifier({ backend })` in `content.ts`:

| Backend | Latency | How it works | Privacy |
|---|---|---|---|
| `"pattern"` | Instant | URL regex matching against known NSFW patterns. Confidence scales with match density. | 🟢 Full — no network |
| `"api"` | ~200ms | POSTs image URL to your moderation endpoint. Bearer auth, 5s timeout, per-session URL cache. | 🟡 URL leaves device |
| `"tfjs"` | ~400ms | Lazy-loads NSFW.js neural network locally. Runs TensorFlow.js inference in-browser. | 🟢 Full — model runs on device |

Sensitivity thresholds map confidence scores to blocking decisions:

| Tier | Threshold | Use case |
|---|---|---|
| Low | ≥ 0.85 | Only near-certain explicit content |
| Balanced | ≥ 0.60 | Smart filtering for everyday browsing |
| Strict | ≥ 0.35 | Block anything with moderate probability |

<br/>

## ✦ Project Structure

```
blur-guard/
├── public/
│   ├── manifest.json              # Chrome MV3 — declares all 3 contexts
│   └── icons/                     # icon16.png · icon48.png · icon128.png
│
├── src/
│   ├── background.ts              # Service worker · state owner · storage
│   ├── content.ts                 # Injected into every tab · detection pipeline
│   ├── main.tsx                   # React popup entry
│   ├── index.css                  # Tailwind v4 · custom CSS vars · glow utilities
│   │
│   ├── types/
│   │   └── messages.ts            # Shared: BlurGuardState · DetectionEvent · MessageType
│   │
│   ├── lib/
│   │   ├── mediaDetector.ts       # Step 2 · MutationObserver · WeakSet scanner
│   │   ├── blurOverlay.ts         # Step 3 · DOM wrapper · click-to-reveal
│   │   └── classifier.ts          # Step 4 · pattern | api | tfjs abstraction
│   │
│   ├── hooks/
│   │   └── useBlurGuard.ts        # React ↔ background bridge · live STATE_UPDATED listener
│   │
│   ├── pages/
│   │   └── Index.tsx              # Popup root · wires all components to live state
│   │
│   └── components/
│       ├── blurguard/
│       │   ├── Header.tsx
│       │   ├── ProtectionStatus.tsx   # Live image/video/blocked counters
│       │   ├── DetectionFeed.tsx      # Real-time detection event list
│       │   ├── SensitivityControl.tsx # Low · Balanced · Strict toggle
│       │   ├── QuickActions.tsx       # Enable / Disable protection
│       │   └── SafetyInsights.tsx     # Sparkline · top domains · avg confidence
│       └── ui/                        # shadcn/ui primitives
│
├── vite.config.ts                 # Multi-entry build · flat output for Chrome
├── tsconfig.app.json              # types: ["chrome"] · @/* path alias
└── postcss.config.js              # @tailwindcss/postcss (Tailwind v4)
```

<br/>

## ✦ Getting Started

### Prerequisites

- **Node.js** ≥ 18
- **Chrome** ≥ 120 (Manifest V3 support)
- **VS Code** (recommended — see [Tutorial](docs/tutorial.md))

### Install & Build

```bash
# 1. Clone the repo
git clone https://github.com/dwakshar/blur-guard.git
cd blur-guard

# 2. Install dependencies
npm install

# 3. Build the extension
npm run build
```

### Load in Chrome

```
1. Open chrome://extensions
2. Enable Developer Mode  (toggle, top-right)
3. Click "Load unpacked"
4. Select the  dist/  folder
5. The BlurGuard icon appears in your toolbar
```

### Development Workflow

```bash
# Rebuild on every file save
npx vite build --watch

# After each rebuild — refresh the extension in chrome://extensions
# OR use the "Extensions Reloader" Chrome extension for one-click reload
```

> **Note:** Never test the extension against the Vite dev server (`npm run dev`). The dev server uses `eval` for HMR, which violates Chrome's Content Security Policy. Always load from `dist/`.

<br/>

## ✦ Message Protocol

All three contexts share a single typed contract in `src/types/messages.ts`:

| Message | Direction | Payload |
|---|---|---|
| `GET_STATE` | popup → background | — Returns `BlurGuardState` |
| `SET_ENABLED` | popup → background | `boolean` |
| `SET_SENSITIVITY` | popup → background | `"low" \| "balanced" \| "strict"` |
| `REPORT_DETECTION` | content → background | `{ kind, src, confidence }` |
| `PROTECTION_TOGGLED` | background → all tabs | `boolean` |
| `SENSITIVITY_CHANGED` | background → all tabs | `Sensitivity` |
| `STATE_UPDATED` | background → popup | Full `BlurGuardState` (push, no polling) |

<br/>

## ✦ Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Extension platform | Chrome MV3 | Only supported format going forward |
| Language | TypeScript 5.8 | Shared types across 3 isolated contexts |
| UI framework | React 19 | Popup UI + component composition |
| Styling | Tailwind v4 | CSS variables, no config file |
| Build tool | Vite 7 | Multi-entry rollup with custom flat output |
| UI components | shadcn/ui | Accessible, unstyled, composable |
| Classification | NSFW.js + TensorFlow.js | On-device inference, no API required |
| State persistence | chrome.storage.local | Survives service worker restarts |
| Icons | lucide-react | Consistent, tree-shakeable |

<br/>

## ✦ How the Blur Overlay Works

Unlike applying `filter: blur()` directly (which repaints and can shift layout), BlurGuard:

1. Captures `offsetWidth`, `offsetHeight`, and all layout CSS from the original element
2. Inserts a `position: relative` wrapper that takes the original's place in the DOM flow, with identical dimensions, margin, flex properties, and border-radius
3. Moves the original element inside the wrapper (filling it 100%)
4. Adds an absolutely-positioned overlay on top with `backdrop-filter: blur()`

The result: **zero layout shift**. The page looks exactly the same — content is simply covered, not removed or resized.

<br/>

## ✦ Privacy

| Backend | Images sent externally | Model data |
|---|---|---|
| `pattern` | Never | No model — regex only |
| `api` | Image URLs only (not pixel data) | Your own endpoint |
| `tfjs` | Never | Model runs entirely in-browser |

BlurGuard does not collect analytics, telemetry, or usage data of any kind. All state is stored locally in `chrome.storage.local`.

<br/>

## ✦ Contributing

Pull requests are welcome. For significant changes, please open an issue first to discuss what you'd like to change.

```bash
# Run type checking
npx tsc --noEmit

# Run tests
npm run test
```

Please ensure TypeScript passes with zero errors before submitting a PR.

<br/>

## ✦ Roadmap

- [ ] **Allowlist** — per-domain opt-out so trusted sites are never scanned
- [ ] **Custom model** — drop-in support for custom ONNX / TFLite models  
- [ ] **Firefox support** — port to WebExtensions API (MV2 compatible)
- [ ] **Statistics export** — download detection history as CSV
- [ ] **WXT migration** — replace custom Vite config with proper extension tooling
- [ ] **Pause timer** — "Pause for 5 minutes" fully implemented with countdown

<br/>

## ✦ License

[MIT](LICENSE) © [dwakshar](https://github.com/dwakshar)

<br/>

---

<div align="center">

Built with TypeScript · React · Chrome MV3 · TensorFlow.js

*Bonking NSFW tabs before you see them.*

</div>
