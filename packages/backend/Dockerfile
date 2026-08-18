# SiteBot Backend — Container.
#
# Basis: node:22-bookworm-slim (node:sqlite benötigt Node >= 22.5).
# Playwright/Chromium + OS-Abhängigkeiten werden im Build installiert.
#
# Aus dem REPO-ROOT bauen (Build-Kontext = Monorepo-Wurzel):
#   docker build -f packages/backend/Dockerfile -t sitebot-backend .
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Nur Manifeste kopieren -> Layer-Caching für npm install.
COPY package.json package-lock.json* ./
COPY packages/backend/package.json packages/backend/package.json
COPY packages/widget/package.json packages/widget/package.json
COPY packages/landing/package.json packages/landing/package.json
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
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV DATABASE_PATH=/app/data/sitebot.sqlite \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000

# Start via tsx (führt die TS-Quellen direkt aus).
CMD ["npx", "tsx", "packages/backend/src/server.ts"]
