# BlurGuard — Chrome Web Store Listing

---

## Extension Name

**BlurGuard**

---

## Short Description (≤ 132 chars)

Detects explicit images and videos on-device and blurs them. No data leaves your browser — classification runs entirely on your GPU.

_(126 chars)_

---

## Full Description

BlurGuard detects explicit images and videos while you browse and covers them with a blur overlay — automatically, before you see them. Every classification decision runs locally in your browser using a TensorFlow.js neural network. No pixels, no URLs, and no data of any kind are ever sent to a server.

---

### How it works

BlurGuard injects a lightweight content script into each page. When an image or video loads, a request is sent to a hidden offscreen document running the NSFW.js model on TensorFlow.js (WebGL/GPU backend, WASM fallback). The model outputs five probability classes — Porn, Hentai, Sexy, Neutral, Drawing — and a verdict is computed locally. The blur overlay is applied before the result arrives: media is blurred by default and revealed only when an on-device SAFE verdict is returned.

**Fail-closed by design.** Any image or video that is pending classification, encounters an inference error, or exceeds the classification timeout remains blurred. Content is never left uncovered due to a slow or failed model run.

---

### Privacy

- All classification runs on your device — the NSFW.js model (~38 MB) is bundled with the extension
- The offscreen document uses `credentials: "omit"` when fetching images — no session cookies or auth tokens are forwarded
- No analytics, telemetry, or usage data are collected
- Detection history is stored only in `chrome.storage.local`, on your device
- The optional Sightengine cloud backend (v1.1, not yet available) will require explicit opt-in and will display a disclosure before activation

---

### Measured accuracy (on-device, post-fix corpus run)

Tested against a hand-labeled set of 15 images (10 safe, 5 explicit). These are the actual numbers from the post-preprocessing-fix evaluation run — no rounding.

| Sensitivity | Explicit recall  | False-positive rate (safe images) |
| ----------- | ---------------- | --------------------------------- |
| Balanced    | 4 / 5 — **80%**  | 0 / 10 — **0%**                   |
| Strict      | 5 / 5 — **100%** | 1 / 10 — **10%**                  |
| Low         | 3 / 5 — **60%**  | 0 / 10 — **0%**                   |

**Known limitation — drawn/animated explicit content:** The NSFW.js model returns near-certain `Drawing` class for animated explicit images regardless of content. On-device recall for this category is approximately 0%. These images are not blurred by default at any sensitivity level.

**Sample size caveat:** n=15 is not statistically significant. A full held-out benchmark evaluation is planned for v1.1.

---

### What BlurGuard does not guarantee

BlurGuard applies a CSS blur overlay — it smears pixels, it does not remove them from the page. A determined user can click any blurred element to reveal it, disable the extension, or remove it entirely. BlurGuard is a heuristic detection layer, not a content filter and not a replacement for parental controls or supervision.

---

### Sensitivity levels

- **Low** — blocks near-certain explicit content only; sportswear and fitness images are safe
- **Balanced** _(default)_ — good precision/recall for everyday browsing; yoga and fitness images unaffected
- **Strict** — flags anything with moderate explicit probability; some suggestive fashion images may be blocked

---

### Other features

- Per-domain allowlist — disable BlurGuard on any site with one tap
- Pause for 5 minutes — temporarily suspend protection with a live countdown
- Live detection feed in the popup — domain, confidence %, inference time, and timestamp
- Export detection history as CSV or JSON
- Zero layout shift — the blur overlay wraps each element in a dimension-preserving container; surrounding content never moves
- Viewport-priority classification queue — images visible on screen are classified first

---

### Performance

- First classification (cold model load): ~4–5 seconds
- Steady-state inference: ~80 ms per image (GPU); ~240–400 ms (WASM fallback)
- Cache hits (already-seen URLs): ~3 ms

---

## MV3 Review Fields

### Single-Purpose Statement

BlurGuard detects explicit images and videos on web pages using an on-device neural network and blurs them with a CSS overlay until a SAFE verdict is confirmed.

---

### Permission Justifications

**Declared permissions (`"permissions"` in manifest.json):**

| Permission  | Justification                                                                                                                                                                                                                                                                 |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`   | Persists BlurGuardState (enabled/disabled, sensitivity, detection feed, per-domain allowlist) and the LRU verdict cache across MV3 service worker sleep/wake cycles via `chrome.storage.local`. Without this, all state is lost when the service worker is killed.            |
| `activeTab` | Identifies the currently active tab so the popup's allowlist toggle can add or remove the correct domain. No tab content is read.                                                                                                                                             |
| `scripting` | Injects the content script (`content.js`) and the pre-blur stylesheet (`preblur.css`) into pages. The content script scans for `<img>` and `<video>` elements and sends classification requests to the background service worker.                                             |
| `tabs`      | Required to broadcast `BLUR_DECISION`, `PROTECTION_TOGGLED`, `SENSITIVITY_CHANGED`, and `ALLOWLIST_UPDATED` messages to all open tabs via `chrome.tabs.sendMessage`. Without this, blur overlays on background tabs cannot be updated when the user changes settings.         |
| `offscreen` | Creates the hidden offscreen document (`offscreen.html`) that runs NSFW.js/TensorFlow.js inference. Chrome MV3 requires this permission to use `chrome.offscreen.createDocument`. The offscreen document provides the DOM context needed for WebGL-accelerated GPU inference. |

**Host permissions (`"host_permissions"`: `<all_urls>`):**

The extension must scan images and videos on every page the user browses. The offscreen document fetches each image URL to run the neural network classifier — it cannot classify an image it cannot fetch. `<all_urls>` is required because the user may encounter explicit content on any domain; restricting to a list of known adult sites would defeat the purpose. All fetches use `credentials: "omit"` and are processed entirely on-device. No URL or pixel data is transmitted to any external service.

---

### Data Safety / Privacy Form Answers

| Question                                                          | Answer                                                                                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Does the extension collect user data?                             | No                                                                                                                                         |
| Does the extension transmit any data to external servers?         | No                                                                                                                                         |
| Does the extension use data for purposes beyond the core feature? | No                                                                                                                                         |
| What data is stored?                                              | User preferences (sensitivity, enabled state, allowlist) and detection history, stored only in `chrome.storage.local` on the user's device |
| Is any data shared with third parties?                            | No                                                                                                                                         |
| Does the extension include analytics or telemetry?                | No                                                                                                                                         |

**Supporting evidence:** The `network-guard.test.ts` suite (5/5 passing) verifies that:

1. `CLOUD_BACKEND_ENABLED` is `false` at build time (Vite dead-code-eliminates the Sightengine path)
2. `OFFSCREEN_CLASSIFY` messages always carry `backend: "tfjs"`, even if `chrome.storage` holds a stale `"sightengine"` value
3. No `sightengineConfig` (API credentials or image payload) is ever forwarded to the offscreen document
4. `SET_API_BACKEND "sightengine"` messages are ignored by the service worker in v1

---

## Pre-Submission Checklist

### Icons

- [ ] `icon16.png` — 16×16 px, present at `public/icons/icon16.png`
- [ ] `icon48.png` — 48×48 px, present at `public/icons/icon48.png`
- [ ] `icon128.png` — 128×128 px, present at `public/icons/icon128.png`
- [ ] Store listing icon: 128×128 px PNG, no rounded corners (Chrome applies them)
- [ ] Promotional tile (optional but recommended): 440×280 px PNG

### Screenshots

- [ ] At least 1 screenshot required; up to 5 recommended
- [ ] Dimensions: 1280×800 or 640×400 px
- [ ] **All screenshots must show blur applied to neutral or synthetic content only** — product mockups, illustrated placeholders, or clearly non-explicit safe images with the blur overlay visible
- [ ] Zero real explicit imagery in any screenshot, promo tile, or icon — the store rejects adult content in listing assets regardless of extension category
- [ ] Screenshots showing the popup dashboard are safe to include without restriction

### Manifest

- [ ] `manifest_version` is `3` ✓
- [ ] `version` is `"1.0.0"` ✓
- [ ] `description` field in manifest.json — update from the placeholder `"Bonking NSFW tabs before you see them."` to a store-appropriate description before submission
- [ ] CSP in manifest: `"script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"` — `wasm-unsafe-eval` is required for TF.js WASM backend and is a known MV3 reviewer flag; be prepared to justify it (WASM execution for local model inference, no remote code)
- [ ] `web_accessible_resources` — `"matches": ["<all_urls>"]` on offscreen.html/models/wasm is required for the offscreen document to load model shards; confirm this is intentional (it is)

### Build

- [ ] `CLOUD_BACKEND_ENABLED=false` confirmed in `vite.config.ts` — Sightengine path is dead-code-eliminated from the v1 bundle
- [ ] Run `npm run build` on a clean checkout and verify `dist/` contains no references to `sightengine` or `api.sightengine.com`
- [ ] Run `npm run test -- src/test/network-guard.test.ts` — all 5 tests must pass before submission

### Store Submission Fields

- [ ] Category: **Productivity** or **Accessibility** (not Adult — this would restrict visibility)
- [ ] Single-purpose statement entered (see above)
- [ ] All permission justifications entered, one per permission
- [ ] Privacy policy URL — required for extensions that declare host permissions; a minimal hosted privacy policy stating on-device-only operation is sufficient
- [ ] Data safety form completed (no data collected, no data transmitted)

### Screenshot Content Confirmation

**All promotional assets must be clean.** The blur effect should be demonstrated using one of:

- A solid-color or gradient placeholder rectangle with the blur overlay visible on top
- Clearly safe stock photography (landscapes, objects, text) with a simulated blur pane overlaid
- Illustrated/vector mockup showing the overlay UI

No real explicit imagery — not even partially blurred — may appear in any store asset. Chrome Web Store's asset review applies regardless of the extension's declared purpose.

---

## Optional v1.1 Note (deferred, do not implement for v1 submission)

A `src → placeholder` swap in the content script — replacing `img.src` with a 1×1 transparent data URI before the offscreen verdict arrives — would provide a hard guarantee that real pixels never paint in the browser's render pipeline during the pending window. This closes the theoretical gap between "blurred" and "never decoded." Deferred to v1.1; v1's fail-closed blur overlay is the shipped behavior.
