import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome116",
    modulePreload: false,
    rollupOptions: {
      input: {
        sidepanel: here("./sidepanel.html"),
        offscreen: here("./offscreen.html"),
        permission: here("./permission.html"),
        report: here("./report.html"),
        "service-worker": here("./src/background/service-worker.ts"),
        "capture-worklet": here("./src/audio/capture-worklet.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
