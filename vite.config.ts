import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react()],

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
});
