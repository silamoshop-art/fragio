/**
 * Repository-Schicht: getypte Zugriffe auf die DB.
 *
 * Kapselt SQL + Multi-Tenant-Isolation an EINER Stelle. Alle wissensbezogenen
 * Abfragen sind zwingend an eine bot_id gebunden — kein Cross-Tenant-Zugriff.
 * INTEGER-Bindungen für vec0 als BigInt (siehe db/index.ts Hinweis).
 */
import { getDb, serializeEmbedding } from "./index.js";
import { newBotId, randomId, newApiKey, sha256 } from "../util/id.js";
import type { ProviderId } from "../llm/types.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

// ── Zeilentypen ─────────────────────────────────────────────────────────────

export interface BotRow {
  id: string;
  tenant_id: string;
  name: string;
  status: "active" | "suspended" | "pending_delete";
  llm_provider: ProviderId;
  encrypted_api_key: string | null;
  chat_model: string | null;
  fallback_to_local: number;
  crawl_start_url: string | null;
  crawl_max_pages: number;
  last_crawled_at: number | null;
  allowed_origins: string; // JSON-Array
  branding: string; // JSON
  trial_mode: number;
  trial_expires_at: number | null;
  trial_request_count: number;
  trial_request_cap: number;
  created_at: number;
  // Kostenkontrolle (Package A)
  max_input_chars: number;
  max_answer_tokens: number;
  monthly_quota: number;
  usage_count: number;
  usage_period: string | null; // "YYYY-MM"
  limit_message: string | null;
  // Auto-Update-Logging (Package C)
  last_crawl_status: string | null;
  last_crawl_error: string | null;
  // Billing (Package D)
  plan: string | null;
  price_cents: number;
  is_paying: number;
  auto_send_invoice: number;
  setup_fee_due_cents: number;
  base_price_cents: number;
  discount_type: string | null;
  discount_value: number;
  addon_logo: number;
  addon_name: number;
  privacy_text: string | null;
  customer_name: string | null;
  customer_address: string | null;
  customer_email: string | null;
  customer_vat: string | null;
  retention_days: number;
  // Zuletzt Chat-Anfrage mit passendem Origin zur hinterlegten Domain (echte Einbindung).
  last_embedded_at: number | null;
}

export interface ChunkHit {
  chunk_id: number;
  content: string;
  page_url: string | null;
  page_title: string | null;
  distance: number;
}

// ── Tenants ─────────────────────────────────────────────────────────────────

export function createTenant(id: string, email: string, apiKeyHash: string): void {
  getDb()
    .prepare(
      "INSERT INTO tenants(id, email, api_key_hash, created_at) VALUES (?,?,?,?)",
    )
    .run(id, email, apiKeyHash, BigInt(Date.now()));
}

export function getTenantByApiKeyHash(hash: string): { id: string; email: string } | undefined {
  return getDb()
    .prepare("SELECT id, email FROM tenants WHERE api_key_hash = ?")
    .get(hash) as { id: string; email: string } | undefined;
}

export interface TenantRow {
  id: string;
  email: string;
  billing_name: string | null;
  billing_address: string | null;
  billing_email: string | null;
  vat_id: string | null;
}

export function getTenant(id: string): TenantRow | undefined {
  return getDb()
    .prepare(
      "SELECT id, email, billing_name, billing_address, billing_email, vat_id FROM tenants WHERE id = ?",
    )
    .get(id) as TenantRow | undefined;
}

export function updateTenantBilling(
  id: string,
  patch: { billing_name?: string; billing_address?: string; billing_email?: string; vat_id?: string },
): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
    vals.push(v);
  }
  if (!cols.length) return;
  vals.push(id);
  getDb().prepare(`UPDATE tenants SET ${cols.join(", ")} WHERE id = ?`).run(...(vals as never[]));
}

// ── Demo-Accounts (Onboarding-Gate, Missbrauchsschutz) ───────────────────────

export interface DemoAccountRow {
  id: string;
  email: string;
  token_hash: string;
  bot_id: string | null;
  created_at: number;
}

/**
 * Demo-Account per E-Mail anlegen ODER (falls vorhanden) nur ein neues Token
 * setzen — created_at und bot_id bleiben erhalten, damit Limits/Ablauf nicht
 * durch erneute Registrierung zurückgesetzt werden können.
 */
export function upsertDemoAccount(email: string, tokenHash: string): DemoAccountRow {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM demo_accounts WHERE email = ?")
    .get(email) as DemoAccountRow | undefined;
  if (existing) {
    db.prepare("UPDATE demo_accounts SET token_hash = ? WHERE id = ?").run(tokenHash, existing.id);
    return { ...existing, token_hash: tokenHash };
  }
  const id = randomId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO demo_accounts(id, email, token_hash, bot_id, created_at) VALUES (?,?,?,NULL,?)",
  ).run(id, email, tokenHash, BigInt(now));
  return { id, email, token_hash: tokenHash, bot_id: null, created_at: now };
}

export function getDemoAccountByToken(tokenHash: string): DemoAccountRow | undefined {
  return getDb()
    .prepare("SELECT * FROM demo_accounts WHERE token_hash = ?")
    .get(tokenHash) as DemoAccountRow | undefined;
}

export function setDemoAccountBot(accountId: string, botId: string | null): void {
  getDb().prepare("UPDATE demo_accounts SET bot_id = ? WHERE id = ?").run(botId, accountId);
}

/** Demo-Accounts, die älter als maxAgeMs sind (für Ablauf-/Sperr-Logik). */
export function listExpiredDemoAccounts(maxAgeMs: number): DemoAccountRow[] {
  const cutoff = Date.now() - maxAgeMs;
  return getDb()
    .prepare("SELECT * FROM demo_accounts WHERE created_at < ?")
    .all(BigInt(cutoff)) as unknown as DemoAccountRow[];
}

export function suspendBot(botId: string): void {
  getDb().prepare("UPDATE bots SET status = 'suspended' WHERE id = ? AND status = 'active'").run(botId);
}

// ── Kunden-Portal-Logins (bot_users) ─────────────────────────────────────────

export interface BotUserRow {
  id: string;
  bot_id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

/** Portal-Login für einen Bot anlegen oder Passwort/E-Mail ersetzen (1 Login/Bot). */
export function upsertBotUser(botId: string, email: string, passwordHash: string): BotUserRow {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM bot_users WHERE bot_id = ?").get(botId) as
    | BotUserRow
    | undefined;
  if (existing) {
    db.prepare("UPDATE bot_users SET email = ?, password_hash = ? WHERE id = ?").run(
      email,
      passwordHash,
      existing.id,
    );
    return { ...existing, email, password_hash: passwordHash };
  }
  const id = randomId();
  const now = Date.now();
  db.prepare(
    "INSERT INTO bot_users(id, bot_id, email, password_hash, created_at) VALUES (?,?,?,?,?)",
  ).run(id, botId, email, passwordHash, BigInt(now));
  return { id, bot_id: botId, email, password_hash: passwordHash, created_at: now };
}

export function getBotUserByEmail(email: string): BotUserRow | undefined {
  return getDb().prepare("SELECT * FROM bot_users WHERE email = ?").get(email) as
    | BotUserRow
    | undefined;
}

export function getBotUserById(id: string): BotUserRow | undefined {
  return getDb().prepare("SELECT * FROM bot_users WHERE id = ?").get(id) as BotUserRow | undefined;
}

export function getBotUserForBot(botId: string): BotUserRow | undefined {
  return getDb().prepare("SELECT * FROM bot_users WHERE bot_id = ?").get(botId) as
    | BotUserRow
    | undefined;
}

// ── Tarifwechsel-Audit (plan_changes) ────────────────────────────────────────

export function recordPlanChange(
  botId: string,
  fromPlan: string | null,
  toPlan: string,
  priceCents: number,
): void {
  getDb()
    .prepare(
      "INSERT INTO plan_changes(bot_id, from_plan, to_plan, price_cents, created_at) VALUES (?,?,?,?,?)",
    )
    .run(botId, fromPlan, toPlan, BigInt(priceCents), BigInt(Date.now()));
}

export interface PlanChangeRow {
  id: number;
  bot_id: string;
  from_plan: string | null;
  to_plan: string;
  price_cents: number;
  created_at: number;
}

/** Tarifwechsel der letzten Zeit für die Bots eines Tenants (Operator-Sicht). */
export function listPlanChangesForTenant(tenantId: string, limit = 50): (PlanChangeRow & { bot_name: string })[] {
  return getDb()
    .prepare(
      `SELECT pc.*, b.name AS bot_name FROM plan_changes pc
       JOIN bots b ON b.id = pc.bot_id
       WHERE b.tenant_id = ? ORDER BY pc.created_at DESC LIMIT ?`,
    )
    .all(tenantId, BigInt(limit)) as unknown as (PlanChangeRow & { bot_name: string })[];
}

// ── Tarif-Anfragen (plan_change_requests, manueller Zahlungsablauf) ───────────

export interface PlanChangeRequestRow {
  id: number;
  bot_id: string;
  plan_id: string;
  variant: string;
  monthly_cents: number;
  setup_cents: number;
  commitment_months: number;
  status: string;
  kind: string; // 'plan' | 'addon_logo' | 'addon_name' | 'addon_bundle'
  created_at: number;
  resolved_at: number | null;
}

export function createPlanChangeRequest(r: {
  botId: string;
  planId: string;
  variant: string;
  monthlyCents: number;
  setupCents: number;
  commitmentMonths: number;
  kind?: string;
}): number {
  const res = getDb()
    .prepare(
      `INSERT INTO plan_change_requests(bot_id, plan_id, variant, monthly_cents, setup_cents, commitment_months, status, kind, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?, ?)`,
    )
    .run(
      r.botId,
      r.planId,
      r.variant,
      BigInt(r.monthlyCents),
      BigInt(r.setupCents),
      BigInt(r.commitmentMonths),
      r.kind ?? "plan",
      BigInt(Date.now()),
    );
  return Number(res.lastInsertRowid);
}

/** Offene Anfrage-Arten (kind) für einen Bot — z. B. um „angefragt" anzuzeigen. */
export function listOpenRequestKinds(botId: string): string[] {
  const rows = getDb()
    .prepare("SELECT kind FROM plan_change_requests WHERE bot_id = ? AND status = 'open'")
    .all(botId) as { kind: string }[];
  return rows.map((r) => r.kind);
}

/** Anfragen der Bots eines Tenants (Operator-Sicht), neueste zuerst. */
export function listPlanChangeRequestsForTenant(
  tenantId: string,
): (PlanChangeRequestRow & { bot_name: string })[] {
  return getDb()
    .prepare(
      `SELECT r.*, b.name AS bot_name FROM plan_change_requests r
       JOIN bots b ON b.id = r.bot_id
       WHERE b.tenant_id = ? ORDER BY (r.status='open') DESC, r.created_at DESC`,
    )
    .all(tenantId) as unknown as (PlanChangeRequestRow & { bot_name: string })[];
}

/** Anfrage nur liefern, wenn ihr Bot dem Tenant gehört (Isolation). */
export function getPlanChangeRequestForTenant(
  id: number,
  tenantId: string,
): PlanChangeRequestRow | undefined {
  return getDb()
    .prepare(
      `SELECT r.* FROM plan_change_requests r JOIN bots b ON b.id = r.bot_id
       WHERE r.id = ? AND b.tenant_id = ?`,
    )
    .get(BigInt(id), tenantId) as PlanChangeRequestRow | undefined;
}

export function markPlanChangeRequestDone(id: number): void {
  getDb()
    .prepare("UPDATE plan_change_requests SET status='done', resolved_at=? WHERE id=?")
    .run(BigInt(Date.now()), BigInt(id));
}

/** Top-Fragen + unbeantwortete Fragen der letzten N Tage (fürs Portal). */
export function getPortalAnalytics(botId: string, days = 30): {
  topQuestions: { question: string; count: number }[];
  unanswered: { question: string; count: number }[];
} {
  const db = getDb();
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const top = db
    .prepare(
      `SELECT question, COUNT(*) AS count FROM chat_logs
       WHERE bot_id = ? AND created_at >= ?
       GROUP BY LOWER(question) ORDER BY count DESC, MAX(created_at) DESC LIMIT 10`,
    )
    .all(botId, BigInt(since)) as unknown as { question: string; count: number }[];
  const un = db
    .prepare(
      `SELECT question, COUNT(*) AS count FROM chat_logs
       WHERE bot_id = ? AND created_at >= ? AND answered = 0
       GROUP BY LOWER(question) ORDER BY count DESC, MAX(created_at) DESC LIMIT 8`,
    )
    .all(botId, BigInt(since)) as unknown as { question: string; count: number }[];
  return {
    topQuestions: top.map((r) => ({ question: r.question, count: Number(r.count) })),
    unanswered: un.map((r) => ({ question: r.question, count: Number(r.count) })),
  };
}

// ── App-Einstellungen (JSON pro Schlüssel) ───────────────────────────────────

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      "INSERT INTO app_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export const OPERATOR_TENANT_ID = "operator";

/**
 * Den EINEN Betreiber-Tenant sicherstellen (keine Selbstregistrierung mehr).
 * api_key_hash + E-Mail kommen aus der Env; bei jedem Start abgeglichen, damit
 * ein geänderter ADMIN_API_KEY sofort greift.
 */
export function ensureOperatorTenant(email: string, apiKeyHash: string): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Belegt ein ANDERER Tenant (z. B. ein alter Testdatensatz) bereits diese E-Mail,
    // wird die E-Mail dort NICHT-destruktiv freigegeben (Suffix), sonst würde der
    // Operator-Upsert an der email-UNIQUE-Regel scheitern und der Serverstart crashen.
    // Bots/Daten des anderen Tenants bleiben erhalten — nur seine E-Mail wird umbenannt.
    db.prepare(
      "UPDATE tenants SET email = email || '.freed-' || id WHERE email = ? AND id != ?",
    ).run(email, OPERATOR_TENANT_ID);

    db.prepare(
      `INSERT INTO tenants(id, email, api_key_hash, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, api_key_hash = excluded.api_key_hash`,
    ).run(OPERATOR_TENANT_ID, email, apiKeyHash, BigInt(Date.now()));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Geteilter System-Tenant für Demo-Bots (Onboarding). Wird bei Bedarf angelegt. */
export function getOrCreateSystemTenant(email: string): string {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM tenants WHERE email = ?")
    .get(email) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = randomId();
  createTenant(id, email, sha256(newApiKey()));
  return id;
}

// ── Bots ──────────────────────────────────────────────────────────────────

export interface CreateBotInput {
  tenantId: string;
  name: string;
  startUrl?: string;
  maxPages?: number;
  allowedOrigins?: string[];
  trialMode?: boolean;
  trialDays?: number;
  trialRequestCap?: number;
}

export function createBot(input: CreateBotInput): BotRow {
  const id = newBotId();
  const now = Date.now();
  const trialExpires =
    input.trialMode && input.trialDays
      ? now + input.trialDays * 24 * 60 * 60 * 1000
      : null;
  getDb()
    .prepare(
      `INSERT INTO bots(
        id, tenant_id, name, status, llm_provider, crawl_start_url, crawl_max_pages,
        allowed_origins, branding, trial_mode, trial_expires_at, trial_request_cap, created_at
      ) VALUES (?,?,?,'active','local',?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      input.tenantId,
      input.name,
      input.startUrl ?? null,
      BigInt(input.maxPages ?? 50),
      JSON.stringify(input.allowedOrigins ?? []),
      "{}",
      input.trialMode ? 1 : 0,
      trialExpires === null ? null : BigInt(trialExpires),
      BigInt(input.trialRequestCap ?? 100),
      BigInt(now),
    );
  return getBot(id)!;
}

export function getBot(id: string): BotRow | undefined {
  return getDb().prepare("SELECT * FROM bots WHERE id = ?").get(id) as
    | BotRow
    | undefined;
}

/** Bot NUR liefern, wenn er dem Tenant gehört (Multi-Tenant-Isolation). */
export function getBotForTenant(id: string, tenantId: string): BotRow | undefined {
  return getDb()
    .prepare("SELECT * FROM bots WHERE id = ? AND tenant_id = ?")
    .get(id, tenantId) as BotRow | undefined;
}

export function listBotsByTenant(tenantId: string): BotRow[] {
  return getDb()
    .prepare("SELECT * FROM bots WHERE tenant_id = ? ORDER BY created_at DESC")
    .all(tenantId) as unknown as BotRow[];
}

export function deleteBot(id: string): void {
  const db = getDb();
  clearBotKnowledge(id); // vec_chunks hat keinen FK-Cascade
  db.prepare("DELETE FROM bots WHERE id = ?").run(id); // chat_logs/chunks/pages via FK-Cascade
  // Hochgeladenes Logo mitlöschen (kein FK; auch relevant für DSGVO-Löschung).
  const logosDir = path.join(path.dirname(config.DATABASE_PATH), "logos");
  for (const ext of ["png", "jpg", "svg"]) {
    const p = path.join(logosDir, `${id}.${ext}`);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/** Erlaubte, vom Dashboard setzbare Felder (partielles Update). */
export interface BotUpdate {
  name?: string;
  llm_provider?: ProviderId;
  encrypted_api_key?: string | null;
  chat_model?: string | null;
  fallback_to_local?: number;
  allowed_origins?: string; // JSON
  branding?: string; // JSON
  crawl_start_url?: string;
  crawl_max_pages?: number;
  status?: string;
  trial_mode?: number;
  trial_expires_at?: number | null;
  // Kostenkontrolle
  max_input_chars?: number;
  max_answer_tokens?: number;
  monthly_quota?: number;
  limit_message?: string | null;
  // Auto-Update-Logging
  last_crawl_status?: string | null;
  last_crawl_error?: string | null;
  // Billing
  plan?: string | null;
  price_cents?: number;
  is_paying?: number;
  auto_send_invoice?: number;
  setup_fee_due_cents?: number;
  base_price_cents?: number;
  discount_type?: string | null;
  discount_value?: number;
  addon_logo?: number;
  addon_name?: number;
  privacy_text?: string | null;
  customer_name?: string | null;
  customer_address?: string | null;
  customer_email?: string | null;
  customer_vat?: string | null;
  retention_days?: number;
}

export function updateBot(id: string, patch: BotUpdate): void {
  const cols: string[] = [];
  const vals: unknown[] = [];
  const intCols = new Set([
    "fallback_to_local",
    "crawl_max_pages",
    "trial_mode",
    "trial_expires_at",
    "max_input_chars",
    "max_answer_tokens",
    "monthly_quota",
    "price_cents",
    "is_paying",
    "auto_send_invoice",
    "setup_fee_due_cents",
    "base_price_cents",
    "discount_value",
    "addon_logo",
    "addon_name",
    "retention_days",
  ]);
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    cols.push(`${key} = ?`);
    // INTEGER-Spalten als BigInt binden (node:sqlite bindet number sonst als REAL).
    vals.push(intCols.has(key) && value !== null ? BigInt(value as number) : value);
  }
  if (!cols.length) return;
  vals.push(id);
  getDb()
    .prepare(`UPDATE bots SET ${cols.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
}

// ── Cleanup (Trial-Cron, Schritt 9) ──────────────────────────────────────────

/** Nicht konvertierte Trial-Bots (trial_mode=1), die älter als maxAgeMs sind. */
export function listStaleTrialBotIds(maxAgeMs: number): string[] {
  const cutoff = Date.now() - maxAgeMs;
  const rows = getDb()
    .prepare("SELECT id FROM bots WHERE trial_mode = 1 AND created_at < ?")
    .all(BigInt(cutoff)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

/** Bots eines System-Tenants (z. B. Demo), die älter als maxAgeMs sind. */
export function listStaleSystemBotIds(tenantEmail: string, maxAgeMs: number): string[] {
  const cutoff = Date.now() - maxAgeMs;
  const rows = getDb()
    .prepare(
      `SELECT b.id FROM bots b JOIN tenants t ON t.id = b.tenant_id
       WHERE t.email = ? AND b.created_at < ?`,
    )
    .all(tenantEmail, BigInt(cutoff)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

// ── Analytics ─────────────────────────────────────────────────────────────

export interface BotAnalytics {
  total: number;
  answered: number;
  unanswered: number;
  topQuestions: { question: string; count: number }[];
  recentUnanswered: { question: string; created_at: number }[];
}

export function getBotAnalytics(botId: string): BotAnalytics {
  const db = getDb();
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN answered=1 THEN 1 ELSE 0 END) AS answered
       FROM chat_logs WHERE bot_id = ?`,
    )
    .get(botId) as { total: number; answered: number | null };
  const total = Number(totals.total || 0);
  const answered = Number(totals.answered || 0);

  const topQuestions = db
    .prepare(
      `SELECT question, COUNT(*) AS count FROM chat_logs
       WHERE bot_id = ? GROUP BY LOWER(question) ORDER BY count DESC, MAX(created_at) DESC LIMIT 10`,
    )
    .all(botId) as unknown as { question: string; count: number }[];

  const recentUnanswered = db
    .prepare(
      `SELECT question, created_at FROM chat_logs
       WHERE bot_id = ? AND answered = 0 ORDER BY created_at DESC LIMIT 20`,
    )
    .all(botId) as unknown as { question: string; created_at: number }[];

  return {
    total,
    answered,
    unanswered: total - answered,
    topQuestions: topQuestions.map((r) => ({ question: r.question, count: Number(r.count) })),
    recentUnanswered: recentUnanswered.map((r) => ({
      question: r.question,
      created_at: Number(r.created_at),
    })),
  };
}

export function setLastCrawledAt(botId: string, when: number): void {
  getDb()
    .prepare("UPDATE bots SET last_crawled_at = ? WHERE id = ?")
    .run(BigInt(when), botId);
}

/**
 * Echte Widget-Einbindung markieren: Zeitpunkt der letzten Chat-Anfrage, deren
 * Origin zur hinterlegten Kunden-Domain passt (Aufrufer prüft das). Gedrosselt —
 * es wird nur geschrieben, wenn der letzte Marker älter als `throttleMs` ist,
 * damit nicht jede Anfrage einen DB-Write auslöst.
 */
export function markEmbeddedSeen(botId: string, when = Date.now(), throttleMs = 3_600_000): void {
  getDb()
    .prepare(
      "UPDATE bots SET last_embedded_at = ? WHERE id = ? AND (last_embedded_at IS NULL OR last_embedded_at < ?)",
    )
    .run(BigInt(when), botId, BigInt(when - throttleMs));
}

/** Ergebnis eines (Auto-)Crawls protokollieren (Package C). */
export function setCrawlResult(botId: string, status: "ok" | "error", error: string | null): void {
  getDb()
    .prepare("UPDATE bots SET last_crawl_status = ?, last_crawl_error = ? WHERE id = ?")
    .run(status, error, botId);
}

/** Aktive Bots mit hinterlegter Start-URL (für den wöchentlichen Recrawl). */
export function listActiveBotsWithUrl(): BotRow[] {
  return getDb()
    .prepare(
      "SELECT * FROM bots WHERE status = 'active' AND crawl_start_url IS NOT NULL AND crawl_start_url != ''",
    )
    .all() as unknown as BotRow[];
}

/** Trial-Kontingent um 1 erhöhen (nach einer über den Trial-Key beantworteten Frage). */
export function incrementTrialCount(botId: string): void {
  getDb()
    .prepare("UPDATE bots SET trial_request_count = trial_request_count + 1 WHERE id = ?")
    .run(botId);
}

/** Aktueller Abrechnungszeitraum als "YYYY-MM" (UTC). */
export function currentPeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  quota: number;
}

/**
 * Monatliches Anfragen-Kontingent atomar prüfen UND (falls erlaubt) verbrauchen.
 *
 * node:sqlite ist synchron und single-threaded pro Prozess: read+check+write ohne
 * dazwischenliegendes await sind daher gegen konkurrierende Requests atomar
 * (kein Overshooting). Bei Monatswechsel wird der Zähler zurückgesetzt.
 * (Für Multi-Prozess-Betrieb wäre ein DB-Lock nötig — MVP läuft single-process.)
 */
export function consumeQuota(botId: string): QuotaResult {
  const db = getDb();
  const period = currentPeriod();
  const row = db
    .prepare("SELECT usage_count, usage_period, monthly_quota FROM bots WHERE id = ?")
    .get(botId) as
    | { usage_count: number; usage_period: string | null; monthly_quota: number }
    | undefined;
  if (!row) return { allowed: false, used: 0, quota: 0 };

  const quota = Number(row.monthly_quota);
  const isNewPeriod = row.usage_period !== period;
  const used = isNewPeriod ? 0 : Number(row.usage_count);

  if (used >= quota) {
    // Limit erreicht -> kein Increment. Bei Monatswechsel dennoch Periode setzen.
    if (isNewPeriod) {
      db.prepare("UPDATE bots SET usage_count = 0, usage_period = ? WHERE id = ?").run(period, botId);
    }
    return { allowed: used < quota, used, quota };
  }

  db.prepare("UPDATE bots SET usage_count = ?, usage_period = ? WHERE id = ?").run(
    BigInt(used + 1),
    period,
    botId,
  );
  return { allowed: true, used: used + 1, quota };
}

/** Nur-Lese-Verbrauch fürs Dashboard (ohne zu verbrauchen). */
export function getBotUsage(bot: BotRow): { used: number; quota: number; period: string } {
  const period = currentPeriod();
  const used = bot.usage_period === period ? bot.usage_count : 0;
  return { used, quota: bot.monthly_quota, period };
}

// ── Wissensbasis (Seiten + Chunks + Vektoren) ────────────────────────────────

/** Komplette Wissensbasis eines Bots löschen (vor Recrawl). Tenant-isoliert. */
export function clearBotKnowledge(botId: string): void {
  const db = getDb();
  db.prepare("DELETE FROM vec_chunks WHERE bot_id = ?").run(botId);
  db.prepare("DELETE FROM chunks WHERE bot_id = ?").run(botId);
  db.prepare("DELETE FROM crawl_pages WHERE bot_id = ?").run(botId);
}

export function upsertPage(
  botId: string,
  url: string,
  title: string | null,
  contentHash: string,
): void {
  getDb()
    .prepare(
      `INSERT INTO crawl_pages(bot_id, url, title, content_hash, fetched_at)
       VALUES (?,?,?,?,?)
       ON CONFLICT(bot_id, url) DO UPDATE SET
         title=excluded.title, content_hash=excluded.content_hash, fetched_at=excluded.fetched_at`,
    )
    .run(botId, url, title, contentHash, BigInt(Date.now()));
}

/** Einen Chunk + sein Embedding speichern. Gibt die neue chunk_id zurück. */
export function insertChunk(
  botId: string,
  content: string,
  embedding: number[],
  pageUrl: string | null,
  pageTitle: string | null,
  tokenCount: number,
): number {
  const db = getDb();
  const res = db
    .prepare(
      `INSERT INTO chunks(bot_id, page_url, page_title, content, token_count, created_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(botId, pageUrl, pageTitle, content, BigInt(tokenCount), BigInt(Date.now()));
  const chunkId = Number(res.lastInsertRowid);
  db.prepare(
    "INSERT INTO vec_chunks(bot_id, chunk_id, embedding) VALUES (?,?,?)",
  ).run(botId, BigInt(chunkId), serializeEmbedding(embedding));
  return chunkId;
}

export function countChunks(botId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM chunks WHERE bot_id = ?")
    .get(botId) as { n: number };
  return Number(row.n);
}

/**
 * KNN-Suche: die Top-K ähnlichsten Chunks eines Bots zur Query-Embedding.
 * Strikt auf bot_id partitioniert -> keine Cross-Tenant-Treffer.
 */
export function searchChunks(
  botId: string,
  queryEmbedding: number[],
  k: number,
): ChunkHit[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT v.chunk_id AS chunk_id, v.distance AS distance,
              c.content AS content, c.page_url AS page_url, c.page_title AS page_title
       FROM vec_chunks v
       JOIN chunks c ON c.id = v.chunk_id
       WHERE v.bot_id = ? AND v.embedding MATCH ? AND k = ?
       ORDER BY v.distance`,
    )
    .all(botId, serializeEmbedding(queryEmbedding), BigInt(k)) as unknown as ChunkHit[];
  return rows;
}

/**
 * Alle Chunks eines Bots leichtgewichtig (ohne Embeddings) laden — Grundlage für
 * die numerische Zusatzsuche (Prompt 14 #2). Für die Zielgröße (kleine Firmen-
 * Websites, i. d. R. < einige Hundert Chunks) ist ein voller Scan unkritisch.
 */
export function allChunksForBot(botId: string): Omit<ChunkHit, "distance">[] {
  return getDb()
    .prepare(
      `SELECT id AS chunk_id, content, page_url AS page_url, page_title AS page_title
         FROM chunks WHERE bot_id = ?`,
    )
    .all(botId) as unknown as Omit<ChunkHit, "distance">[];
}

// ── Manuelle FAQs (Prompt 14 #5) ─────────────────────────────────────────────

export interface ManualFaqRow {
  id: number;
  bot_id: string;
  question: string;
  answer: string;
  created_at: number;
  updated_at: number;
}

export function listManualFaqs(botId: string): ManualFaqRow[] {
  return getDb()
    .prepare("SELECT * FROM manual_faqs WHERE bot_id = ? ORDER BY created_at DESC")
    .all(botId) as unknown as ManualFaqRow[];
}

export function createManualFaq(botId: string, question: string, answer: string): ManualFaqRow {
  const now = Date.now();
  const res = getDb()
    .prepare(
      `INSERT INTO manual_faqs(bot_id, question, answer, created_at, updated_at)
       VALUES (?,?,?,?,?)`,
    )
    .run(botId, question, answer, BigInt(now), BigInt(now));
  return getDb()
    .prepare("SELECT * FROM manual_faqs WHERE id = ?")
    .get(Number(res.lastInsertRowid)) as unknown as ManualFaqRow;
}

/** FAQ aktualisieren — NUR wenn sie diesem Bot gehört (Tenant-/Bot-Isolation). */
export function updateManualFaq(
  botId: string,
  id: number,
  question: string,
  answer: string,
): boolean {
  const res = getDb()
    .prepare(
      "UPDATE manual_faqs SET question = ?, answer = ?, updated_at = ? WHERE id = ? AND bot_id = ?",
    )
    .run(question, answer, BigInt(Date.now()), BigInt(id), botId);
  return Number(res.changes) > 0;
}

/** FAQ löschen — NUR wenn sie diesem Bot gehört. */
export function deleteManualFaq(botId: string, id: number): boolean {
  const res = getDb()
    .prepare("DELETE FROM manual_faqs WHERE id = ? AND bot_id = ?")
    .run(BigInt(id), botId);
  return Number(res.changes) > 0;
}

// ── Rechnungen (Package D) ───────────────────────────────────────────────────

export interface InvoiceRow {
  id: number;
  invoice_number: string;
  bot_id: string;
  tenant_id: string;
  period: string;
  period_label: string;
  amount_cents: number;
  currency: string;
  plan: string | null;
  pdf_path: string;
  sent: number;
  created_at: number;
  paid: number;
  paid_at: number | null;
  due_date: number | null;
  reminder_sent_at: number | null;
}

/** Zahlungsziel in Tagen ab Rechnungsdatum (Fälligkeit). */
export const INVOICE_DUE_DAYS = 14;

/** Zahlende, aktive Bots mit Preis (für den monatlichen Rechnungslauf). */
export function listPayingBots(): BotRow[] {
  return getDb()
    .prepare("SELECT * FROM bots WHERE status = 'active' AND is_paying = 1 AND price_cents > 0")
    .all() as unknown as BotRow[];
}

/**
 * Nächste lückenlose Rechnungsnummer für ein Jahr — transaktionssicher.
 * BEGIN IMMEDIATE nimmt sofort eine Schreibsperre, sodass parallele Läufe keine
 * Nummer doppelt vergeben.
 */
export function nextInvoiceNumber(year: number): string {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT last_seq FROM invoice_counters WHERE year = ?")
      .get(BigInt(year)) as { last_seq: number } | undefined;
    const next = (row ? Number(row.last_seq) : 0) + 1;
    if (row) {
      db.prepare("UPDATE invoice_counters SET last_seq = ? WHERE year = ?").run(
        BigInt(next),
        BigInt(year),
      );
    } else {
      db.prepare("INSERT INTO invoice_counters(year, last_seq) VALUES (?, ?)").run(
        BigInt(year),
        BigInt(next),
      );
    }
    db.exec("COMMIT");
    return `${year}-${String(next).padStart(3, "0")}`;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function insertInvoice(
  inv: Omit<InvoiceRow, "id" | "created_at" | "paid" | "paid_at" | "due_date" | "reminder_sent_at">,
): number {
  const now = Date.now();
  const dueDate = now + INVOICE_DUE_DAYS * 24 * 60 * 60 * 1000;
  const res = getDb()
    .prepare(
      `INSERT INTO invoices(invoice_number, bot_id, tenant_id, period, period_label,
         amount_cents, currency, plan, pdf_path, sent, created_at, due_date)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      inv.invoice_number,
      inv.bot_id,
      inv.tenant_id,
      inv.period,
      inv.period_label,
      BigInt(inv.amount_cents),
      inv.currency,
      inv.plan,
      inv.pdf_path,
      BigInt(inv.sent),
      BigInt(now),
      BigInt(dueDate),
    );
  return Number(res.lastInsertRowid);
}

/** Hatte dieser Bot schon einmal eine Rechnung? (für „nur erste Rechnung"-Logik) */
export function botHasInvoice(botId: string): boolean {
  const row = getDb()
    .prepare("SELECT 1 AS x FROM invoices WHERE bot_id = ? LIMIT 1")
    .get(botId) as { x: number } | undefined;
  return !!row;
}

export function clearSetupFeeDue(botId: string): void {
  getDb().prepare("UPDATE bots SET setup_fee_due_cents = 0 WHERE id = ?").run(botId);
}

export function getInvoiceForBotPeriod(botId: string, period: string): InvoiceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM invoices WHERE bot_id = ? AND period = ?")
    .get(botId, period) as InvoiceRow | undefined;
}

export function listInvoicesForBot(botId: string): InvoiceRow[] {
  return getDb()
    .prepare("SELECT * FROM invoices WHERE bot_id = ? ORDER BY created_at DESC")
    .all(botId) as unknown as InvoiceRow[];
}

/** Rechnung nur liefern, wenn sie dem Tenant gehört (Isolation). */
export function getInvoiceForTenant(invoiceId: number, tenantId: string): InvoiceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM invoices WHERE id = ? AND tenant_id = ?")
    .get(BigInt(invoiceId), tenantId) as InvoiceRow | undefined;
}

export function markInvoiceSent(invoiceId: number): void {
  getDb().prepare("UPDATE invoices SET sent = 1 WHERE id = ?").run(BigInt(invoiceId));
}

/** Offene (unbezahlte) Rechnung inkl. Kunden-/Bot-Daten für die „Offene Zahlungen"-Liste. */
export interface OpenInvoiceRow extends InvoiceRow {
  bot_name: string;
  billing_name: string | null;
  billing_email: string | null;
}

/** Alle offenen Rechnungen eines Tenants, älteste Fälligkeit zuerst. */
export function listOpenInvoicesForTenant(tenantId: string): OpenInvoiceRow[] {
  return getDb()
    .prepare(
      `SELECT i.*, b.name AS bot_name,
              b.customer_name AS billing_name, b.customer_email AS billing_email
         FROM invoices i
         JOIN bots b ON b.id = i.bot_id
        WHERE i.tenant_id = ? AND i.paid = 0
        ORDER BY COALESCE(i.due_date, i.created_at) ASC`,
    )
    .all(tenantId) as unknown as OpenInvoiceRow[];
}

/** Rechnung als bezahlt markieren (tenant-scoped). Gibt false zurück, wenn nicht gefunden. */
export function markInvoicePaid(invoiceId: number, tenantId: string): boolean {
  const res = getDb()
    .prepare("UPDATE invoices SET paid = 1, paid_at = ? WHERE id = ? AND tenant_id = ?")
    .run(BigInt(Date.now()), BigInt(invoiceId), tenantId);
  return Number(res.changes) > 0;
}

/** Zeitstempel der letzten Mahnung setzen. */
export function markInvoiceReminderSent(invoiceId: number): void {
  getDb()
    .prepare("UPDATE invoices SET reminder_sent_at = ? WHERE id = ?")
    .run(BigInt(Date.now()), BigInt(invoiceId));
}

// ── DSGVO-Consent-Nachweis (anonym) ──────────────────────────────────────────

/** Eine anonyme Zustimmung protokollieren (nur Bot + Zeitstempel). */
export function logConsent(botId: string): void {
  getDb()
    .prepare("INSERT INTO consent_events(bot_id, created_at) VALUES (?, ?)")
    .run(botId, BigInt(Date.now()));
}

/** Anzahl + letzter Zeitstempel der Zustimmungen eines Bots (für den Admin-Nachweis). */
export function consentStats(botId: string): { count: number; lastAt: number | null } {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS c, MAX(created_at) AS last FROM consent_events WHERE bot_id = ?")
    .get(botId) as { c: number; last: number | null };
  return { count: Number(row.c), lastAt: row.last != null ? Number(row.last) : null };
}

// ── Chat-Log / Analytics ─────────────────────────────────────────────────────

export function insertChatLog(entry: {
  botId: string;
  question: string;
  answer: string | null;
  answered: boolean;
  topScore: number | null;
  provider: string | null;
  latencyMs: number | null;
  ipHash?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO chat_logs(bot_id, question, answer, answered, top_score, provider, latency_ms, ip_hash, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      entry.botId,
      entry.question,
      entry.answer,
      entry.answered ? 1 : 0,
      entry.topScore,
      entry.provider,
      entry.latencyMs === null ? null : BigInt(entry.latencyMs),
      entry.ipHash ?? null,
      BigInt(Date.now()),
    );
}

/** Chat-Log-Detailansicht (jüngste zuerst). Zeigt gehashte IP, nicht die echte IP. */
export interface ChatLogRow {
  id: number;
  question: string;
  answer: string | null;
  answered: number;
  ip_hash: string | null;
  created_at: number;
}
export function listChatLogs(botId: string, limit = 100): ChatLogRow[] {
  return getDb()
    .prepare(
      `SELECT id, question, answer, answered, ip_hash, created_at
         FROM chat_logs WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(botId, BigInt(limit)) as unknown as ChatLogRow[];
}

/** Alle Anfragen desselben Absenders (gleicher IP-Hash) löschen (Art. 17 DSGVO). */
export function deleteChatLogsByIpHash(botId: string, ipHash: string): number {
  const res = getDb()
    .prepare("DELETE FROM chat_logs WHERE bot_id = ? AND ip_hash = ?")
    .run(botId, ipHash);
  return Number(res.changes);
}

/** Chat-Logs löschen, die älter sind als die pro-Bot-Speicherdauer (retention_days). */
export function deleteExpiredChatLogs(now = Date.now()): number {
  const res = getDb()
    .prepare(
      `DELETE FROM chat_logs WHERE id IN (
         SELECT cl.id FROM chat_logs cl JOIN bots b ON b.id = cl.bot_id
         WHERE cl.created_at < ? - (b.retention_days * 86400000))`,
    )
    .run(BigInt(now));
  return Number(res.changes);
}
