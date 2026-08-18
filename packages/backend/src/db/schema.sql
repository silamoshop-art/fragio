-- SiteBot Schema (SQLite). Multi-Tenant-Isolation über bot_id / tenant_id.
-- Die sqlite-vec Vektor-Tabelle (vec_chunks) wird in db/index.ts erzeugt,
-- damit die Embedding-Dimension mit config.EMBEDDING_DIM synchron bleibt.

PRAGMA foreign_keys = ON;

-- Kunden (Tenants). Ein Tenant kann mehrere Bots besitzen.
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,           -- uuid
  email         TEXT UNIQUE NOT NULL,
  -- Management-API-Key wird nur als Hash gespeichert (Auth in Schritt 8).
  api_key_hash  TEXT NOT NULL,
  created_at    INTEGER NOT NULL            -- epoch ms
);

-- Bots = 1 Website + 1 Wissensbasis + 1 öffentliche botId + Konfiguration.
CREATE TABLE IF NOT EXISTS bots (
  id                   TEXT PRIMARY KEY,     -- öffentliche botId (nicht geheim)
  tenant_id            TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',   -- active | suspended | pending_delete

  -- LLM-Provider-Konfiguration (siehe llm/). encrypted_api_key: AES-256-GCM.
  llm_provider         TEXT NOT NULL DEFAULT 'local',    -- local | anthropic | openai
  encrypted_api_key    TEXT,                             -- NULL im lokalen Modus
  chat_model           TEXT,                             -- NULL = Provider-Default
  fallback_to_local    INTEGER NOT NULL DEFAULT 0,       -- bei API-Ausfall auf lokal zurückfallen

  -- Crawl-Konfiguration
  crawl_start_url      TEXT,
  crawl_max_pages      INTEGER NOT NULL DEFAULT 50,
  last_crawled_at      INTEGER,

  -- Sicherheit / Multi-Tenant: erlaubte Origin-Domains (JSON-Array), CORS-Whitelist
  allowed_origins      TEXT NOT NULL DEFAULT '[]',

  -- Widget-Branding (JSON: primaryColor, greeting, logoUrl, botName)
  branding             TEXT NOT NULL DEFAULT '{}',

  -- Trial-Modus (Schritt 9)
  trial_mode           INTEGER NOT NULL DEFAULT 0,
  trial_expires_at     INTEGER,
  trial_request_count  INTEGER NOT NULL DEFAULT 0,
  trial_request_cap    INTEGER NOT NULL DEFAULT 100,

  created_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bots_tenant ON bots(tenant_id);
CREATE INDEX IF NOT EXISTS idx_bots_trial ON bots(trial_mode, trial_expires_at);

-- Gecrawlte Seiten (eine Zeile pro URL). content_hash zur Änderungserkennung beim Recrawl.
CREATE TABLE IF NOT EXISTS crawl_pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  url           TEXT NOT NULL,
  title         TEXT,
  content_hash  TEXT,
  fetched_at    INTEGER NOT NULL,
  UNIQUE(bot_id, url)
);
CREATE INDEX IF NOT EXISTS idx_pages_bot ON crawl_pages(bot_id);

-- Text-Chunks der Wissensbasis. Zu jedem Chunk existiert eine Zeile in vec_chunks
-- (verknüpft über chunks.id == vec_chunks.chunk_id).
CREATE TABLE IF NOT EXISTS chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  page_url      TEXT,
  page_title    TEXT,
  content       TEXT NOT NULL,
  token_count   INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_bot ON chunks(bot_id);

-- Chat-/Analytics-Log. Grundlage für "häufigste" und "unbeantwortete" Fragen.
CREATE TABLE IF NOT EXISTS chat_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id        TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  question      TEXT NOT NULL,
  answer        TEXT,
  answered      INTEGER NOT NULL DEFAULT 1,   -- 0 = "weiß ich nicht" / kein relevanter Kontext
  top_score     REAL,                         -- beste Ähnlichkeit (Distanz) der Top-K
  provider      TEXT,
  latency_ms    INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_bot ON chat_logs(bot_id, created_at);

-- Rechnungen (Package D). invoice_number ist fortlaufend pro Jahr ("2026-001").
CREATE TABLE IF NOT EXISTS invoices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE NOT NULL,
  bot_id         TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period         TEXT NOT NULL,              -- Leistungszeitraum, z. B. "2026-07"
  period_label   TEXT NOT NULL,              -- menschlich, z. B. "01.07.–31.07.2026"
  amount_cents   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'EUR',
  plan           TEXT,
  pdf_path       TEXT NOT NULL,
  sent           INTEGER NOT NULL DEFAULT 0, -- 1 = per E-Mail an Kunde versendet
  created_at     INTEGER NOT NULL,
  UNIQUE(bot_id, period)                     -- pro Bot & Zeitraum nur eine Rechnung
);
CREATE INDEX IF NOT EXISTS idx_invoices_bot ON invoices(bot_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);

-- Globale App-Einstellungen (JSON pro Schlüssel), z. B. Preise. Admin-editierbar.
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Zähler für lückenlose, jahresweise Rechnungsnummern (transaktionssicher hochzählen).
CREATE TABLE IF NOT EXISTS invoice_counters (
  year      INTEGER PRIMARY KEY,
  last_seq  INTEGER NOT NULL
);

-- Kostenlose Demo-Accounts (nur E-Mail, keine Kreditkarte) als Missbrauchsschutz
-- fürs Onboarding: pro Account max. 1 Demo-Bot, begrenzte Chats, Ablauf nach ~72h.
CREATE TABLE IF NOT EXISTS demo_accounts (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE NOT NULL,
  token_hash  TEXT NOT NULL,          -- SHA-256 des Demo-Tokens
  bot_id      TEXT,                    -- aktueller (einziger) Demo-Bot des Accounts
  created_at  INTEGER NOT NULL
);

-- Kunden-Portal-Logins: EIN Login pro Bot. Der Kunde sieht ausschließlich diesen
-- einen Bot (Isolation via Session-Token, der an bot_id gebunden ist).
CREATE TABLE IF NOT EXISTS bot_users (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL UNIQUE REFERENCES bots(id) ON DELETE CASCADE,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,        -- scrypt: s1$<salt>$<hash>
  created_at     INTEGER NOT NULL
);

-- Tarif-ANFRAGEN aus dem Portal (manueller Zahlungsablauf). Der Bot wird NICHT
-- automatisch geändert; der Operator schaltet nach Zahlungseingang frei.
CREATE TABLE IF NOT EXISTS plan_change_requests (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id             TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  plan_id            TEXT NOT NULL,
  variant            TEXT NOT NULL,           -- 'setup' | 'commit'
  monthly_cents      INTEGER NOT NULL,
  setup_cents        INTEGER NOT NULL,
  commitment_months  INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'done'
  created_at         INTEGER NOT NULL,
  resolved_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pcr_bot ON plan_change_requests(bot_id, status);

-- DSGVO-Consent-Nachweis (Audit-Punkt 6): ANONYM — nur Bot + Zeitstempel, KEINE
-- personenbezogenen Daten (keine IP, kein User-Agent). Dient als aggregierter Nachweis,
-- dass und wann Nutzer der KI-Verarbeitung zugestimmt haben.
CREATE TABLE IF NOT EXISTS consent_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_bot ON consent_events(bot_id, created_at);

-- Audit/Benachrichtigung: tatsächlich durchgeführter Tarifwechsel (Freischaltung).
CREATE TABLE IF NOT EXISTS plan_changes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id       TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  from_plan    TEXT,
  to_plan      TEXT NOT NULL,
  price_cents  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_changes_bot ON plan_changes(bot_id, created_at);
