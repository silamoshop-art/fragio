# CLAUDE.md — Fragio (SiteBot)

Leitfaden für die Arbeit an diesem Repo. Kurz, konkret, wartungsorientiert.

## Was ist das

Fragio ist ein einbettbarer, mandantenfähiger RAG-Chatbot als SaaS (Domain: fragio.at).
Ein Bot liest die öffentlichen Inhalte einer Kundenwebsite ein und beantwortet
Besucherfragen **ausschließlich** daraus — mit Quellenangabe und ehrlichem „weiß ich
nicht", statt zu erfinden. Betreiber: Kleinunternehmer in Österreich (läuft über die
Eltern, Betreiber selbst unter 18).

## Monorepo (npm workspaces)

- `packages/backend` — Fastify + TypeScript, via `tsx` ausgeführt (kein Build nötig zum Start). Crawler (Playwright), Vektor-DB (sqlite-vec), RAG, LLM-Provider, Rechnungen, Admin-/Portal-API. Serviert außerdem alle statischen Pakete.
- `packages/landing/public` — Marketing-Website (statisches Multi-Page-HTML) + Self-Service-Demo. Gemeinsames Design-System: `site.css` + `site.js` + `i18n.js`. Details siehe [DESIGN.md](DESIGN.md).
- `packages/widget` — einbettbares Chat-Widget (Vanilla JS + Shadow DOM).
- `packages/dashboard` — React+Vite Admin (`/admin/`, gebaut nach `dist/`).
- `packages/portal` — React+Vite Kunden-Portal (`/portal/`, per-Bot-Login).

## Häufige Befehle

```bash
# Backend lokal starten (Standardport 3000; für Vorschau oft 8080)
PORT=8080 HOST=127.0.0.1 npx tsx packages/backend/src/server.ts

# TypeScript-Build prüfen (Backend)
npm --workspace @sitebot/backend run build

# Dashboard/Portal bauen (erzeugt dist/, das Backend serviert es)
npm --workspace @sitebot/dashboard run build
npm --workspace @sitebot/portal run build

# DB initialisieren (frische Instanz)
npm --workspace @sitebot/backend run db:init
```

## Wichtige Konventionen & Gotchas

- **DB:** `node:sqlite` (nicht better-sqlite3). `PRAGMA foreign_keys = ON` — Löschen kaskadiert über `bot_id`/`tenant_id`. **INTEGER-Spalten kommen als BigInt zurück.** Schema in `packages/backend/src/db/schema.sql` (wird beim DB-Öffnen automatisch angewandt).
- **Löschen:** `deleteBot()` entfernt Wissensbasis (inkl. `vec_chunks` ohne FK-Cascade), alle FK-Kinder (Rechnungen inkl. Mahnungs-Zeitstempel, Portal-Login) **und** die Rechnungs-PDFs von der Platte + Logo.
- **Betreiberdaten:** `operator.config.json` (Repo-Root, **gitignored**) — Name, Adresse, Bank (IBAN/BIC), UID/Steuerhinweis (Kleinunternehmer), Support-Kontakt. Rechnungsmodul liest ausschließlich hierüber. Fehlt die Datei → sichtbare Platzhalter + Warnung.
- **Public-URL:** `PUBLIC_BACKEND_URL` (.env) muss in Produktion gesetzt sein (z. B. `https://fragio.at`) — sonst zeigen Widget-Snippet, E-Mail-/Rechnungslinks auf `localhost`.
- **LLM:** Standard Anthropic Haiku 4.5 (`ANTHROPIC_DEFAULT_MODEL`), Embeddings **lokal** (Xenova, In-Process). System-Prompt pro Bot stabil → Prompt-Caching aktiv (`llm/providers/anthropic.ts`). Kunden können eigenen Key (Anthropic/OpenAI) hinterlegen.
- **Rechnung/Zahlung:** Nur **Banküberweisung** (kein PayPal). Verwendungszweck = `Rechnungsnummer + Firmenname` (QR füllt das aus). Abo-Zeitraum läuft **ab dem Bestelltag** (`dayPeriod()`), nicht ab Monatsanfang. Kein USt-Ausweis (Kleinunternehmer). Einrichtungsgebühr optional per Admin-Toggle (nur Neukunden, Erstrechnung).
- **Demo/Trial-Bots:** eigener Demo-Tenant, getrennt vom Operator-Tenant. `trial_mode`-Bots **loggen nie** Gesprächsdaten; Demo-Wissensbasis wird ≤ 24 h automatisch gelöscht.
- **Admin-Auth:** einziger Betreiber-Login unter `/admin/`, `Authorization: Bearer <ADMIN_API_KEY>` (aus .env). Bots/Preise/„Offene Zahlungen als bezahlt markieren" → löst Provisionierung aus.
- **i18n (Website):** `i18n.js` — deutscher Quelltext, Nachschlag über `textContent`; gemischte Elemente brauchen `data-i18n-en`. Bei Textänderung eines Wörterbuch-Schlüssels **den Schlüssel in i18n.js mitziehen**, sonst bricht die EN-Übersetzung.
- **Sicherheit:** SSRF-Guard beim Einlesen (`util/url-guard.ts`), IP nur gehasht (SHA-256+Salt), Rate-Limits + Kontingente, Kunden-API-Keys verschlüsselt (AES-256-GCM via `APP_SECRET`).

## Deployment

Details in [DEPLOYMENT.md](DEPLOYMENT.md). Kurz: Docker Compose (`docker compose up -d --build`, mountet `.env` + `operator.config.json`) **oder** PM2 (`pm2 start ecosystem.config.cjs`). HTTPS-Reverse-Proxy (Caddy) davor. Auf dem Server einmalig `npx playwright install --with-deps chromium`.

## Recht

Impressum/Datenschutz/AGB unter `packages/landing/public`. Muster-Auftragsverarbeitungsvertrag (AVV, Art. 28 DSGVO) für B2B-Kunden existiert als separate Vorlage. **Alle Rechtstexte sind Muster — vor Live-Gang anwaltlich/WKO prüfen lassen.**
