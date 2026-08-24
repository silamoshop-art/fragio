/**
 * Zentrale Konfiguration, aus Umgebungsvariablen geladen und validiert.
 *
 * Standard-Setup:
 * - Antwort-Generierung: Claude Haiku 4.5 über ANTHROPIC_API_KEY (DEFAULT_ENGINE=anthropic).
 * - Embeddings: lokal In-Process via @xenova/transformers (multilingual-e5-small, 384 Dim).
 * - APP_SECRET verschlüsselt die von Kunden hinterlegten API-Keys (AES-256-GCM).
 *
 * WICHTIG: Die .env wird IMMER aus dem Repo-Root geladen (absoluter Pfad),
 * unabhängig vom aktuellen Arbeitsverzeichnis. So gibt es genau EINE .env als
 * Quelle der Wahrheit (nicht cwd-abhängig — sonst würde je nach Startort mal
 * packages/backend/.env, mal die Root-.env greifen).
 */
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Projekt-Root relativ zu packages/backend/src -> ../../../
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// .env deterministisch aus dem Repo-Root laden.
loadDotenv({ path: path.join(repoRoot, ".env") });

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),

  // Öffentliche Basis-URL des Backends (z. B. "https://fragio.at"). Speist ALLE
  // nach außen sichtbaren Links (Widget-Snippet, Vorschau-Link, Portal-/Logo-/
  // Datenschutz-URL, Stripe-Redirects) über util/embed.ts. Ist sie gesetzt, wird
  // sie verwendet; sonst Fallback auf http://localhost:PORT (lokale Entwicklung).
  PUBLIC_BACKEND_URL: z.string().url().optional(),

  // Pfad zur SQLite-DB. Default: <repo>/data/sitebot.sqlite
  DATABASE_PATH: z.string().default(path.join(repoRoot, "data", "sitebot.sqlite")),

  // 32-Byte-Secret (hex oder base64) für AES-256-GCM Verschlüsselung der Kunden-Keys.
  // In Produktion ZWINGEND setzen. Im Dev wird ein flüchtiger Key erzeugt (mit Warnung).
  APP_SECRET: z.string().optional(),

  // --- Einziger Betreiber-Zugang (keine Selbstregistrierung, kein Multi-Admin) ---
  // Der Admin meldet sich im Dashboard mit ADMIN_API_KEY an. In Produktion setzen.
  ADMIN_API_KEY: z.string().optional(),
  ADMIN_EMAIL: z.string().default("admin@sitebot.local"),

  // --- Zahlungen: Stripe-Schalter (Default AUS -> manueller Ablauf) ---
  // "true" => Portal-Tarifklick startet Stripe-Checkout; sonst wird eine Anfrage
  // gespeichert und der Operator schaltet manuell frei. Später nur umlegen.
  STRIPE_ENABLED: z.string().default("false"),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // --- Standard-Engine für die Antwort-Generierung ---
  // "anthropic" (Default): Claude Haiku 4.5 über den Operator-Key ANTHROPIC_API_KEY.
  // "ollama": optionaler lokaler Modus (nur falls Ollama betrieben wird).
  DEFAULT_ENGINE: z.enum(["anthropic", "ollama"]).default("anthropic"),

  // Operator-Anthropic-Key: wird für die Standard-Engine (Haiku 4.5) und – wenn
  // kein separater Trial-Key gesetzt ist – auch für den Trial-Modus verwendet.
  ANTHROPIC_API_KEY: z.string().optional(),

  // --- Embeddings: lokal In-Process via @xenova/transformers (KEIN Ollama nötig) ---
  // Mehrsprachiges Retrieval-Modell (Deutsch-tauglich), 384 Dim. e5 erwartet
  // "query:"/"passage:"-Präfixe (der Embedder setzt sie automatisch, siehe embedder.ts).
  EMBEDDING_MODEL: z.string().default("Xenova/multilingual-e5-small"),
  // Muss zur Ausgabedimension des Modells passen; bei Wechsel wird der Vektor-Index
  // automatisch neu aufgebaut (Bots müssen dann neu gecrawlt werden).
  EMBEDDING_DIM: z.coerce.number().int().positive().default(384),

  // --- Ollama (OPTIONAL, nur wenn DEFAULT_ENGINE="ollama") ---
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("phi3"),

  // --- Auto-Update (Package C): Cron-Ausdruck für den wöchentlichen Recrawl ---
  // Default: Sonntag 03:00. Format: node-cron (min h dom mon dow).
  RECRAWL_CRON: z.string().default("0 3 * * 0"),

  // --- Trial (Schritt 9): eigener, zentral hinterlegter Key ---
  TRIAL_ANTHROPIC_API_KEY: z.string().optional(),
  TRIAL_ANTHROPIC_MODEL: z.string().default("claude-haiku-4-5-20251001"),

  // Standard-Modelle für Bring-your-own-Key Provider (überschreibbar pro Bot später)
  ANTHROPIC_DEFAULT_MODEL: z.string().default("claude-haiku-4-5-20251001"),
  OPENAI_DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
  OPENAI_DEFAULT_EMBED_MODEL: z.string().default("text-embedding-3-small"),

  // --- E-Mail-Versand (SMTP, generisch via nodemailer) ---
  // Sind Host+User+Pass gesetzt, verschickt notify/email.ts echt; sonst nur Log-Stub.
  // Funktioniert mit jedem Anbieter (eigenes Postfach, Mailbox.org, Gmail, Resend/Postmark via SMTP …).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: z.string().default("false"), // "true" => Port 465 (implizites TLS)
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(), // Absender, z. B. "SiteBot <no-reply@deine-domain.at>"

  // --- Backup (Punkt 2 Audit): täglicher SQLite-Snapshot ---
  BACKUP_CRON: z.string().default("0 4 * * *"), // täglich 04:00
  BACKUP_KEEP_DAYS: z.coerce.number().int().positive().default(14),

  // --- Rechnungen (Package D): Firmenkopf des Betreibers (Leistender) ---
  // Platzhalter bis Gewerbe/Steuerberater stehen — jederzeit per Env setzbar.
  INVOICE_ISSUER_NAME: z.string().default("[Dein Firmenname]"),
  INVOICE_ISSUER_ADDRESS: z.string().default("[Straße, PLZ Ort]"),
  INVOICE_ISSUER_VAT: z.string().default("[UID-Nummer / Steuerhinweis]"),
  INVOICE_CURRENCY: z.string().default("EUR"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Ungültige Umgebungskonfiguration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

// In Produktion sollte die öffentliche Basis-URL gesetzt sein, sonst erscheinen in
// Snippet/Vorschau-/Portal-Links "localhost"-Adressen statt der echten Domain.
if (env.NODE_ENV === "production" && !env.PUBLIC_BACKEND_URL) {
  console.warn(
    "⚠️  PUBLIC_BACKEND_URL ist in Produktion nicht gesetzt — nach außen sichtbare " +
      "Links (Snippet, Vorschau, Portal) fallen auf http://localhost zurück. " +
      "Bitte PUBLIC_BACKEND_URL=https://deine-domain in der .env setzen.",
  );
}

// APP_SECRET: 32 Bytes aus hex/base64/utf8 ableiten. Fehlt er im Dev, warnen + flüchtigen Key erzeugen.
import crypto from "node:crypto";
function deriveSecretKey(raw: string | undefined): Buffer {
  if (!raw) {
    if (env.NODE_ENV === "production") {
      console.error("❌ APP_SECRET ist in Produktion erforderlich (32 Byte).");
      process.exit(1);
    }
    console.warn(
      "⚠️  APP_SECRET nicht gesetzt — erzeuge flüchtigen Dev-Key. " +
        "Verschlüsselte Kunden-Keys sind nach Neustart NICHT mehr entschlüsselbar!",
    );
    return crypto.randomBytes(32);
  }
  // hex (64 Zeichen) oder base64, sonst als Passphrase via scrypt auf 32 Byte bringen.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return crypto.scryptSync(raw, "sitebot-app-secret-salt", 32);
}

// Admin-Key ableiten: in Prod Pflicht, im Dev fester Fallback (mit Warnung),
// damit der Login lokal über Neustarts hinweg stabil bleibt.
function deriveAdminKey(raw: string | undefined): string {
  if (raw) return raw;
  if (env.NODE_ENV === "production") {
    console.error("❌ ADMIN_API_KEY ist in Produktion erforderlich.");
    process.exit(1);
  }
  console.warn('⚠️  ADMIN_API_KEY nicht gesetzt — Dev-Fallback "dev-admin-key" wird genutzt.');
  return "dev-admin-key";
}

export const config = {
  ...env,
  repoRoot,
  isProd: env.NODE_ENV === "production",
  secretKey: deriveSecretKey(env.APP_SECRET),
  adminApiKey: deriveAdminKey(env.ADMIN_API_KEY),
  stripeEnabled: env.STRIPE_ENABLED === "true",
  smtpEnabled: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
  smtpSecure: env.SMTP_SECURE === "true",
};

export type AppConfig = typeof config;
