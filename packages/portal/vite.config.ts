import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Wird vom Backend unter /portal/ ausgeliefert -> base entsprechend setzen,
// damit Asset-Pfade stimmen. Dev-Proxy leitet /api ans Backend.
export default defineConfig({
  base: "/portal/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: true } },
  },
  build: { outDir: "dist" },
});
