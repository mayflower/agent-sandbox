import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/healthz": "http://127.0.0.1:8080",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
