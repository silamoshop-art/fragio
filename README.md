# SiteBot — Embeddable RAG-Chatbot (SaaS)

Ein einbettbarer KI-Chatbot, den Website-Betreiber per `<script>`-Snippet einbinden.
Der Bot beantwortet Besucherfragen anhand der echten Inhalte der jeweiligen Website
(RAG — Retrieval Augmented Generation).

**Hosting-Modell:** Ein zentrales Backend (Crawler, Vektor-DB, RAG-Endpoint,
LLM-Provider) bedient viele Kunden (Multi-Tenant). Auf der Kunden-Website liegt nur
das kleine Widget-Snippet.

## Architektur (Monorepo)

```
packages/
  backend/     Fastify + TS: Crawler, sqlite-vec Vektor-DB, RAG-Endpoint, LLM-Provider
  widget/      Vanilla-JS Widget (Shadow DOM)        [Schritt 4/6]
  dashboard/   React + Vite Admin-Dashboard           [Schritt 7]
  shared/      Gemeinsame Typen                        [später]
```

## LLM-Provider-Abstraktion

Pro Bot konfigurierbar (`llm_provider`):

- **`local`** — Standard-Engine: **Claude Haiku 4.5** über deinen Operator-Key
  `ANTHROPIC_API_KEY`. (Optional lokaler Ollama-Chat via `DEFAULT_ENGINE=ollama`.)
- **`anthropic` / `openai`** — Bring-your-own-Key (Kunde trägt Kosten; Key
  AES-256-GCM-verschlüsselt gespeichert).
- **Trial** — `trial_mode`: nutzt den zentral hinterlegten Trial-Key.

> **Embeddings laufen lokal In-Process** via `@xenova/transformers`
> (`multilingual-e5-small`, 384 Dim) — **kein Ollama nötig, kein extra API-Key**.
> Nur die Antwort-Generierung nutzt Claude. Siehe
> [`packages/backend/src/llm/embedder.ts`](packages/backend/src/llm/embedder.ts).

## Voraussetzungen

- Node.js ≥ 20
- Ein **Anthropic-API-Key** (für die Standard-Engine Claude Haiku 4.5).
  Kein Ollama erforderlich. Das Embedding-Modell lädt beim ersten Start
  automatisch (einmalig, danach offline).

## Setup & Schritt-1-Test

```bash
npm install
cp .env.example .env            # APP_SECRET + ANTHROPIC_API_KEY setzen!

# Smoke-Test: DB + sqlite-vec + lokale Embeddings + KNN
# (Chat wird übersprungen, wenn kein ANTHROPIC_API_KEY gesetzt ist)
npm run backend:test:llm
```

## Umgebungsvariablen

Siehe [`.env.example`](.env.example). Wichtig: `APP_SECRET` in Produktion setzen —
ohne ihn sind verschlüsselte Kunden-Keys nach Neustart nicht mehr entschlüsselbar.

## Status

- [x] Schritt 1 — Projekt-Setup, DB-Schema, LLM-Provider-Abstraktion
- [x] Schritt 2 — Crawler-Modul (`npm run backend:test:crawl -- <url> [maxPages]`)
- [x] Schritt 3 — RAG-Chat-Endpoint (`POST /api/chat`, SSE-Streaming)
- [x] Schritt 4 — Minimal-Widget (Vanilla JS, SSE-Client)
- [x] Schritt 5 — Gratis-/Vorschau-Modell: Operator legt Bots an, teilt Vorschau-Link
  (`/preview.html?bot=…`); Landing (`/`) ist Marketing-/Kontaktseite (kein öffentlicher Crawl)
- [x] Schritt 6 — Widget mit Shadow DOM, Branding, responsive (`/widget/widget.js`)
- [x] Schritt 7 — Admin-Dashboard (React+Vite, `/admin/`; Bots/Engine/Branding/Analytics)
- [x] Schritt 8 — Auth (API-Key), Rate-Limit pro Bot/IP, CORS-Domain-Whitelist
- [x] Schritt 9 — Trial-Modus (Kontingent, Ablauf bei Request, Cron-Cleanup)
- [x] Schritt 10 — Deployment (Docker + Compose) — siehe [DEPLOYMENT.md](DEPLOYMENT.md)
- [x] Migration — Standard-Engine **Claude Haiku 4.5** (Anthropic-Key); Embeddings
  lokal via `@xenova/transformers` (kein Ollama). `test:quota/recrawl/billing/trial` grün.

Alle Schritte per CLI-/curl-/Playwright-Tests verifiziert. Tests:
`test:llm`, `test:crawl`, `test:trial`, `test:quota`, `test:recrawl`, `test:billing`
(im Backend-Workspace).

### Erweiterungen (Audit-Folgeauftrag)

- **Kostenkontrolle:** pro Bot Input-Zeichenlimit, `max_tokens`, **monatliches
  Anfragen-Kontingent** (atomare Prüfung pro Anfrage, Reset am Monatsersten,
  Standard-Antwort bei Limit). System-Prompt auf kurze Antworten getrimmt.
- **Dashboard:** Sektion „Limits & Kontingent" (Verbrauchsbalken + 80%-Warnung),
  Status aktiv/pausiert-Toggle, Warnung bei leerer Domain-Whitelist.
- **Auto-Update:** wöchentlicher Recrawl-Cron (`RECRAWL_CRON`), Index-Schutz bei
  Fehlschlag (alter Stand bleibt), Erfolg/Fehler-Log im Dashboard.
- **Rechnungstool:** monatlicher Cron, PDF-Rechnungen (pdfkit), fortlaufende
  Jahresnummer (transaktionssicher), Historie + Download im Dashboard, optionaler
  Mailversand-Flag, Fehler bei fehlenden Kundendaten (keine Lücken-Rechnung).

### Backend starten & Chat testen

```bash
npm run backend:dev            # Fastify auf http://localhost:3000
# Bot mit Inhalt befüllen (gibt eine botId aus):
npm run backend:test:crawl -- https://quotes.toscrape.com 5
# Chat (SSE):
curl -sN -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"botId":"<botId>","message":"Deine Frage"}'
```
