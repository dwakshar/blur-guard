(function () {
  const loaderState = window;
  const runtime =
    typeof chrome !== "undefined" && chrome.runtime?.getURL
      ? chrome.runtime
      : null;

  if (loaderState.__blurGuardTfLoader) {
    return;
  }

  const ensureScript = (src, test) =>
    new Promise((resolve, reject) => {
      if (test()) {
        resolve();
        return;
      }

      const existing = document.querySelector(`script[data-bg-src="${src}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), {
          once: true,
        });
        return;
      }

      const script = document.createElement("script");
      script.src = src;
      script.async = false;
      script.dataset.bgSrc = src;
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error(`Failed to load ${src}`)),
        { once: true }
      );
      (document.head ?? document.documentElement).appendChild(script);
    });

  loaderState.__blurGuardTfLoader = (async () => {
    if (!runtime) {
      throw new Error("BlurGuard runtime URL resolver unavailable");
    }

    await ensureScript(
      runtime.getURL("vendor/nsfwjs.min.js"),
      () => typeof window.nsfwjs !== "undefined"
    );
  })();
})();
