import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  plugins: [react()],

  // Build-time constants — Rollup replaces these with literals and dead-code-eliminates
  // branches gated on false values. __CLOUD_ENABLED__: false strips the Sightengine
  // module from the v1 bundle entirely. Flip to true for v1.1.
  define: {
    __CLOUD_ENABLED__: false,
  },

  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },

  build: {
    outDir: "dist",
    emptyOutDir: true,

    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        offscreen: resolve(__dirname, "offscreen.html"),
        diagnostic: resolve(__dirname, "diagnostic.html"), // THROWAWAY — remove after measurement
      },

      output: {
        // SW, content script, and offscreen entry must not carry a hash —
        // the manifest and createDocument() reference them by stable name.
        entryFileNames: (chunk) => {
          if (["background", "content", "offscreen"].includes(chunk.name)) {
            return "[name].js";
          }
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },

  test: {
    environment: "node",
  },
});
