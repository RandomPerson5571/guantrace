import { defineConfig } from "vite";
import { resolve } from "node:path";
import tauriConfig from "./src-tauri/tauri.conf.json";

const devUrl = new URL(tauriConfig.build.devUrl);
const host = devUrl.hostname;
const port = Number(devUrl.port);

export default defineConfig(({ mode }) => ({
  root: resolve(__dirname, "src"),
  base: "./",
  publicDir: false,
  server: {
    host,
    port: mode === "tauri" ? port : undefined,
    strictPort: mode === "tauri",
  },
  preview: {
    host,
  },
  build: {
    target: "esnext",
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/index.html"),
        brainGraph: resolve(__dirname, "src/brain-graph.html"),
      },
    },
  },
}));
