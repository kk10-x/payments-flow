import { defineConfig } from "vite";

// In dev, the Vite server proxies API + WebSocket traffic to the gateway on :8080.
export default defineConfig({
  root: "web",
  base: "./",
  server: {
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/events": { target: "ws://127.0.0.1:8080", ws: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 700 },
});
