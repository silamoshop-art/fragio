/**
 * pm2-Prozessmanager-Konfiguration (Audit-Punkt 4: Auto-Restart bei Absturz).
 *
 * Nutzung auf dem Produktivserver (Alternative zu Docker):
 *   npm install                                   # Dependencies
 *   npm --workspace @sitebot/backend run build    # dist/ erzeugen
 *   npm i -g pm2
 *   pm2 start ecosystem.config.cjs                # startet + überwacht
 *   pm2 save && pm2 startup                        # Autostart nach Server-Reboot
 *
 * Logs:  pm2 logs sitebot-backend
 * Status: pm2 status
 *
 * .env wird vom Prozess selbst aus dem Repo-Root geladen (config.ts), unabhängig
 * vom Arbeitsverzeichnis — hier müssen keine Secrets dupliziert werden.
 */
module.exports = {
  apps: [
    {
      name: "sitebot-backend",
      cwd: "./packages/backend",
      script: "dist/server.js",
      instances: 1, // SQLite = 1 Instanz (kein Cluster-Mode)
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s", // schnelle Crash-Loops als Fehler werten
      watch: false,
      max_memory_restart: "600M",
      env: { NODE_ENV: "production" },
    },
  ],
};
