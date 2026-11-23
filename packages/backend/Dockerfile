# SiteBot Backend — Container.
#
# Basis: node:24-bookworm-slim (node:sqlite ist ab Node 24 stabil, kein
# --experimental-sqlite-Flag mehr nötig). Review 2026-11-22 (F-003/F-007):
# vorher node:22-bookworm-slim ohne Flag → Import schlug fehl.
# Playwright/Chromium + OS-Abhängigkeiten werden im Build installiert.
#
# Aus dem REPO-ROOT bauen (Build-Kontext = Monorepo-Wurzel):
#   docker build -f packages/backend/Dockerfile -t sitebot-backend .
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Nur Manifeste kopieren -> Layer-Caching für npm install.
# Review 2026-11-22 (F-003/F-014): packages/landing hat KEINE package.json,
# die COPY-Zeile für sie wurde entfernt — sonst bricht `docker compose build`.
COPY package.json package-lock.json* ./
COPY packages/backend/package.json packages/backend/package.json
COPY packages/widget/package.json packages/widget/package.json
COPY packages/dashboard/package.json packages/dashboard/package.json

# Prod-Deps des Backends installieren (Workspaces).
RUN npm install --omit=dev --workspace @sitebot/backend

# Chromium + Systemabhängigkeiten für den Crawler (playwright ist hoisted im Root).
RUN npx playwright install --with-deps chromium

# tsx wird zum Ausführen der TS-Quellen genutzt (kein separater Build-Step nötig).
RUN npm install --no-save tsx@^4.19.2

# Quellcode + statische Assets kopieren.
COPY tsconfig.base.json ./
COPY packages/backend ./packages/backend
COPY packages/widget ./packages/widget
COPY packages/landing ./packages/landing

# Datenverzeichnis (SQLite) als Volume-Mountpunkt.
# Review 2026-11-22 (F-012): /app wird dem unprivilegierten User node übergeben,
# der Container läuft ab jetzt nicht mehr als root (Härtung gegen Crawler-/RCE-Lücken).
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

ENV DATABASE_PATH=/app/data/sitebot.sqlite \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

USER node

# Start via tsx (führt die TS-Quellen direkt aus).
CMD ["npx", "tsx", "packages/backend/src/server.ts"]
