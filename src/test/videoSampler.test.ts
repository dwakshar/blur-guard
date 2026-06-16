// src/test/videoSampler.test.ts
//
// Unit tests for VideoFrameSampler: cap enforcement, lifecycle (start/stop/markBlurred),
// and frame dispatch to the sendFrame callback.
//
// Runs in Node — browser globals needed by the module are stubbed below.

import { describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_VIDEO_SAMPLERS,
  VideoFrameSampler,
} from "../lib/videoSampler";

// ── Node-env stubs for browser globals used by VideoFrameSampler ──────────────

// window.setInterval / clearInterval: delegate to Node's built-ins.
vi.stubGlobal("window", {
  setInterval: (fn: (...args: unknown[]) => unknown, ms: number) =>
    setInterval(fn as () => void, ms),
  clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
});

// HTMLMediaElement.HAVE_CURRENT_DATA = 2 (used by doSample readyState guard)
vi.stubGlobal("HTMLMediaElement", { HAVE_CURRENT_DATA: 2 });

// ── Fake HTMLVideoElement factory ─────────────────────────────────────────────

interface FakeVideo {
  isConnected: boolean;
  readyState: number;
  videoWidth: number;
  videoHeight: number;
  poster: string;
  currentSrc: string;
  src: string;
  paused: boolean;
  ended: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  querySelector: ReturnType<typeof vi.fn>;
}

function makeVideo(overrides: Partial<FakeVideo> = {}): HTMLVideoElement {
  return {
    isConnected: false,
    readyState: 0,
    videoWidth: 0,
    videoHeight: 0,
    poster: "",
    currentSrc: "",
    src: "",
    paused: true,
    ended: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: vi.fn().mockReturnValue(null),
    ...overrides,
  } as unknown as HTMLVideoElement;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSampler(
  sendFrame = vi.fn(),
  isPending = vi.fn().mockReturnValue(false),
) {
  const inViewport = new WeakSet<Element>();
  return new VideoFrameSampler(sendFrame, isPending, () => inViewport);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("VideoFrameSampler", () => {
  describe("start / stop lifecycle", () => {
    it("start() returns true and isSampling() becomes true", () => {
      const s = makeSampler();
      const el = makeVideo();

      expect(s.start(el)).toBe(true);
      expect(s.isSampling(el)).toBe(true);
      expect(s.activeCount).toBe(1);

      s.stopAll();
    });

    it("start() is idempotent — calling twice on the same element returns true, count stays 1", () => {
      const s = makeSampler();
      const el = makeVideo();

      s.start(el);
      expect(s.start(el)).toBe(true);
      expect(s.activeCount).toBe(1);

      s.stopAll();
    });

    it("stop() makes isSampling() false and decrements activeCount", () => {
      const s = makeSampler();
      const el = makeVideo();

      s.start(el);
      expect(s.isSampling(el)).toBe(true);

      s.stop(el);
      expect(s.isSampling(el)).toBe(false);
      expect(s.activeCount).toBe(0);
    });

    it("stopAll() removes every active sampler", () => {
      const s = makeSampler();
      const els = [makeVideo(), makeVideo(), makeVideo()];
      els.forEach((el) => s.start(el));
      expect(s.activeCount).toBe(3);

      s.stopAll();
      expect(s.activeCount).toBe(0);
      els.forEach((el) => expect(s.isSampling(el)).toBe(false));
    });
  });

  describe("cap enforcement", () => {
    it(`start() returns false when ${MAX_ACTIVE_VIDEO_SAMPLERS} samplers are already active`, () => {
      const s = makeSampler();

      // Fill to the cap
      const active = Array.from({ length: MAX_ACTIVE_VIDEO_SAMPLERS }, () => {
        const el = makeVideo();
        expect(s.start(el)).toBe(true);
        return el;
      });
      expect(s.activeCount).toBe(MAX_ACTIVE_VIDEO_SAMPLERS);

      // One more must be rejected
      const extra = makeVideo();
      expect(s.start(extra)).toBe(false);
      expect(s.isSampling(extra)).toBe(false);
      expect(s.activeCount).toBe(MAX_ACTIVE_VIDEO_SAMPLERS);

      s.stopAll();
      active; // suppress unused warning
    });

    it("after a stop(), a new sampler can be started again", () => {
      const s = makeSampler();
      const els = Array.from({ length: MAX_ACTIVE_VIDEO_SAMPLERS }, () => makeVideo());
      els.forEach((el) => s.start(el));

      s.stop(els[0]);
      expect(s.activeCount).toBe(MAX_ACTIVE_VIDEO_SAMPLERS - 1);

      const newEl = makeVideo();
      expect(s.start(newEl)).toBe(true);

      s.stopAll();
    });
  });

  describe("markBlurred", () => {
    it("markBlurred() stops sampling so the video is no longer polled", () => {
      const s = makeSampler();
      const el = makeVideo();

      s.start(el);
      expect(s.isSampling(el)).toBe(true);

      s.markBlurred(el);
      expect(s.isSampling(el)).toBe(false);
    });
  });

  describe("frame dispatch", () => {
    it("sendFrame callback is invoked when the video has a fallback src and readyState >= 2", () => {
      const sendFrame = vi.fn();
      const s = makeSampler(sendFrame);

      // readyState=2 passes the guard; videoWidth=0 makes captureVideoFrame return null
      // so the sampler falls back to el.currentSrc.
      const el = makeVideo({
        isConnected: true,
        readyState: 2,
        videoWidth: 0,
        currentSrc: "https://example.com/video.mp4",
      });

      s.start(el);

      expect(sendFrame).toHaveBeenCalledOnce();
      const [frameId, url, calledEl] = sendFrame.mock.calls[0] as [string, string, HTMLVideoElement, string];
      expect(frameId).toMatch(/^bg-vf-/);
      expect(url).toBe("https://example.com/video.mp4");
      expect(calledEl).toBe(el);

      s.stopAll();
    });

    it("sendFrame is NOT called when readyState < HAVE_CURRENT_DATA", () => {
      const sendFrame = vi.fn();
      const s = makeSampler(sendFrame);

      const el = makeVideo({ isConnected: true, readyState: 0 }); // HAVE_NOTHING
      s.start(el);

      expect(sendFrame).not.toHaveBeenCalled();
      s.stopAll();
    });
  });
});
