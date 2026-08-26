/**
 * SQLite-Verbindung + sqlite-vec Vektorsuche.
 *
 * - node:sqlite (in Node.js eingebaut ab v22.5, stabil in v24): synchrones,
 *   schnelles SQLite OHNE Native-Kompilierung — ideal fürs MVP auf Windows/Linux
 *   ohne Build-Toolchain.
 * - sqlite-vec: vorgebaute Loadable Extension für KNN-Vektorsuche direkt in SQLite.
 *
 * Multi-Tenant-Isolation der Vektoren: `vec_chunks` nutzt `bot_id` als
 * PARTITION KEY. Jede KNN-Abfrage MUSS `bot_id = ?` angeben — dadurch durchsucht
 * die Engine ausschließlich die Partition des jeweiligen Bots (Isolation + Tempo).
 */
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { embedSignature } from "../llm/embedder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (_db) return _db;

  // Datenverzeichnis sicherstellen.
  fs.mkdirSync(path.dirname(config.DATABASE_PATH), { recursive: true });

  // allowExtension: Voraussetzung, damit loadExtension() erlaubt ist.
  const db = new DatabaseSync(config.DATABASE_PATH, { allowExtension: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  // sqlite-vec Extension laden (bringt Prebuilt-Binary für die Plattform mit).
  db.enableLoadExtension(true);
  db.loadExtension(sqliteVec.getLoadablePath());
  db.enableLoadExtension(false); // danach wieder abschalten (Sicherheit)

  // Sanity-Check: vec-Version abrufen (wirft, falls Extension nicht geladen ist).
  const row = db.prepare("SELECT vec_version() AS version").get() as {
    version: string;
  };
  if (config.NODE_ENV !== "test") {
    console.log(`🔗 sqlite-vec geladen (${row.version})`);
  }

  // Relationales Schema anwenden.
  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  db.exec(schema);

  // Leichte, idempotente Migrationen: fehlende Spalten additiv ergänzen,
  // damit bestehende DBs ohne Neuanlage aktuell bleiben.
  runMigrations(db);

  // Embedding-Setup-Signatur (Modell:Dimension). Ändert sie sich (z. B. Wechsel
  // von Ollama/nomic 768 auf transformers 384), ist der alte Vektor-Index
  // inkompatibel -> Index + Chunks zurücksetzen; Bots bleiben, müssen aber neu
  // gecrawlt werden.
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  const sig = embedSignature();
  const stored = (
    db.prepare("SELECT value FROM meta WHERE key = 'embed_signature'").get() as
      | { value: string }
      | undefined
  )?.value;
  // Reset, wenn Signatur abweicht ODER (Legacy-DB) noch gar keine hinterlegt ist,
  // aber bereits eine vec_chunks-Tabelle mit evtl. anderer Dimension existiert.
  const vecExists =
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'")
        .get() as { name: string } | undefined
    ) !== undefined;
  const needsReset = stored !== sig && (stored !== undefined || vecExists);
  if (needsReset) {
    console.warn(
      `⚠️  Embedding-Setup geändert (${stored ?? "unbekannt"} → ${sig}). Wissensbasen ` +
        `werden zurückgesetzt — bitte betroffene Bots neu crawlen.`,
    );
    db.exec("DROP TABLE IF EXISTS vec_chunks");
    db.exec("DELETE FROM chunks");
    db.exec("DELETE FROM crawl_pages");
    db.exec(
      "UPDATE bots SET last_crawled_at = NULL, last_crawl_status = NULL, last_crawl_error = NULL",
    );
  }

  // Vektor-Tabelle erzeugen — Dimension aus config (muss zum Embed-Modell passen).
  // distance_metric=cosine: interpretierbare Distanz in [0,2] für die Relevanz-
  // Schwelle ("weiß ich nicht"-Entscheidung im RAG).
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
      bot_id TEXT partition key,
      chunk_id INTEGER,
      embedding FLOAT[${config.EMBEDDING_DIM}] distance_metric=cosine
    );
  `);
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('embed_signature', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(sig);

  _db = db;
  return db;
}

/**
 * Additive Spalten-Migrationen (ADD COLUMN ist in SQLite idempotent machbar,
 * indem wir vorhandene Spalten via PRAGMA table_info prüfen).
 */
function runMigrations(db: DatabaseSync): void {
  const migrations: { table: string; column: string; ddl: string }[] = [
    // Kostenkontrolle (Package A)
    { table: "bots", column: "max_input_chars", ddl: "INTEGER NOT NULL DEFAULT 500" },
    { table: "bots", column: "max_answer_tokens", ddl: "INTEGER NOT NULL DEFAULT 250" },
    { table: "bots", column: "monthly_quota", ddl: "INTEGER NOT NULL DEFAULT 500" },
    { table: "bots", column: "usage_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "bots", column: "usage_period", ddl: "TEXT" },
    { table: "bots", column: "limit_message", ddl: "TEXT" },
    // Auto-Update-Logging (Package C)
    { table: "bots", column: "last_crawl_status", ddl: "TEXT" },
    { table: "bots", column: "last_crawl_error", ddl: "TEXT" },
    // Billing (Package D)
    { table: "bots", column: "plan", ddl: "TEXT" },
    { table: "bots", column: "price_cents", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "bots", column: "is_paying", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "bots", column: "auto_send_invoice", ddl: "INTEGER NOT NULL DEFAULT 0" },
    // Einmalige Einrichtungsgebühr, die auf der ersten Rechnung berechnet wird.
    { table: "bots", column: "setup_fee_due_cents", ddl: "INTEGER NOT NULL DEFAULT 0" },
    // Basispreis (vor Rabatt) + individueller Kundenrabatt (überschreibt nur diesen Bot).
    { table: "bots", column: "base_price_cents", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "bots", column: "discount_type", ddl: "TEXT" }, // 'percent' | 'fixed' | NULL
    { table: "bots", column: "discount_value", ddl: "INTEGER NOT NULL DEFAULT 0" }, // % oder Cent
    // Branding-Zusatzoptionen (Section E), erst nach Freischaltung nutzbar.
    { table: "bots", column: "addon_logo", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "bots", column: "addon_name", ddl: "INTEGER NOT NULL DEFAULT 0" },
    // Pro Bot editierbarer Datenschutztext (Consent-Popup, Section C).
    { table: "bots", column: "privacy_text", ddl: "TEXT" },
    // Einstellbarer Schreibstil (Prompt 4/Änderung): Textbeispiel, an dessen TONFALL
    // (nicht Inhalt) sich der Bot orientiert. Recrawl-fest (Bot-Spalte, nicht Crawl).
    { table: "bots", column: "style_sample", ddl: "TEXT" },
    // Rechnungsdaten DES KUNDEN — pro Bot eigenständig (Prompt 9 #1: vorher fälschlich
    // global auf dem Tenant → alle Bots teilten sich eine E-Mail/Adresse).
    { table: "bots", column: "customer_name", ddl: "TEXT" },
    { table: "bots", column: "customer_address", ddl: "TEXT" },
    { table: "bots", column: "customer_email", ddl: "TEXT" },
    { table: "bots", column: "customer_vat", ddl: "TEXT" },
    // Speicherdauer der Chat-Verläufe in Tagen (Auftrag 2.2, Standard 90).
    { table: "bots", column: "retention_days", ddl: "INTEGER NOT NULL DEFAULT 90" },
    // Zuletzt echte Widget-Einbindung erkannt: Zeitpunkt der letzten Chat-Anfrage,
    // deren Origin zur hinterlegten (nicht-leeren) Kunden-Domain passt. Grundlage
    // für "Bereits eingebunden" im Portal — Test-/Vorschau-Traffic zählt NICHT.
    { table: "bots", column: "last_embedded_at", ddl: "INTEGER" },
    // Gehashte IP-Adresse pro Chat-Log (Auftrag 2.3, SHA-256 mit Salt; keine Klartext-IP).
    { table: "chat_logs", column: "ip_hash", ddl: "TEXT" },
    { table: "tenants", column: "billing_name", ddl: "TEXT" },
    { table: "tenants", column: "billing_address", ddl: "TEXT" },
    { table: "tenants", column: "billing_email", ddl: "TEXT" },
    { table: "tenants", column: "vat_id", ddl: "TEXT" },
    // Anfrage-Art: 'plan' oder 'addon_logo' | 'addon_name' | 'addon_bundle' (Section E)
    { table: "plan_change_requests", column: "kind", ddl: "TEXT NOT NULL DEFAULT 'plan'" },
    // Zahlungsstatus & Mahnwesen (Section D: „Offene Zahlungen").
    { table: "invoices", column: "paid", ddl: "INTEGER NOT NULL DEFAULT 0" },
    { table: "invoices", column: "paid_at", ddl: "INTEGER" },
    { table: "invoices", column: "due_date", ddl: "INTEGER" }, // Fälligkeit (Zeitstempel)
    { table: "invoices", column: "reminder_sent_at", ddl: "INTEGER" }, // letzte Mahnung
  ];
  for (const m of migrations) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`);
    }
  }
}

/** Für Tests / sauberes Herunterfahren. */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/**
 * Ein Embedding (Float32-Array) für sqlite-vec serialisieren.
 * sqlite-vec akzeptiert rohe Float32-Bytes als kompaktestes BLOB-Format.
 * node:sqlite bindet Uint8Array als BLOB.
 */
export function serializeEmbedding(vec: number[]): Uint8Array {
  const f32 = new Float32Array(vec);
  return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}
