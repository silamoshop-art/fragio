import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: /api wird an das Backend (Port 3000) weitergereicht, damit dieselbe
// Origin genutzt wird und der API-Key nicht über CORS gehen muss.
export default defineConfig({
  // Wird vom Backend unter /admin/ ausgeliefert -> Assets müssen relativ dazu
  // referenziert werden (sonst 404 auf /assets/...). Analog zum Portal (/portal/).
  base: "/admin/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: true },
    },
  },
  build: { outDir: "dist" },
});
