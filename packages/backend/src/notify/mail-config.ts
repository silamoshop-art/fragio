/**
 * Effektive E-Mail-Versand-Konfiguration: .env-Werte + im Admin gespeicherte
 * Overrides (app_settings "mail_config"). So kann der Betreiber SMTP-Zugang und
 * die Empfänger-Adresse für Benachrichtigungen im Dashboard setzen — ohne die
 * .env auf dem Server anzufassen. Das SMTP-Passwort wird verschlüsselt gespeichert.
 */
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/repo.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";

const KEY = "mail_config";

interface StoredMail {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  passEnc?: string; // verschlüsseltes SMTP-Passwort
  from?: string;
  notifyEmail?: string; // Empfänger für Betreiber-Benachrichtigungen
}

export interface MailConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  /** Adresse, an die Betreiber-Benachrichtigungen (Bestellung, 80 %, Leads …) gehen. */
  notifyEmail: string;
  /** Versand aktiv? (Host + User + Passwort vorhanden) */
  enabled: boolean;
}

function readStored(): StoredMail {
  try {
    const raw = getSetting(KEY);
    if (raw) return JSON.parse(raw) as StoredMail;
  } catch {
    /* ignorieren */
  }
  return {};
}

/** Effektive Mail-Konfiguration (DB-Override über .env). */
export function getMailConfig(): MailConfig {
  const s = readStored();
  const host = (s.host ?? config.SMTP_HOST ?? "").trim();
  const user = (s.user ?? config.SMTP_USER ?? "").trim();
  let pass = config.SMTP_PASS ?? "";
  if (s.passEnc) {
    try {
      pass = decryptSecret(s.passEnc);
    } catch {
      /* falls Key-Wechsel: Passwort gilt als leer */
      pass = "";
    }
  }
  const port = s.port ?? config.SMTP_PORT ?? 587;
  const secure = s.secure ?? config.smtpSecure;
  const from = (s.from ?? config.SMTP_FROM ?? "").trim();
  const notifyEmail = (s.notifyEmail ?? config.ADMIN_EMAIL).trim();
  return { host, port, secure, user, pass, from, notifyEmail, enabled: !!(host && user && pass) };
}

/** Signatur der aktiven Verbindungsdaten — für Transport-Cache-Invalidierung. */
export function mailConfigSignature(): string {
  const c = getMailConfig();
  return [c.host, c.port, c.secure, c.user, c.pass ? "pw" : "-"].join("|");
}

export interface MailPatch {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string | null; // null/"" => Passwort löschen; undefined => unverändert
  from?: string;
  notifyEmail?: string;
}

export function saveMailConfig(patch: MailPatch): void {
  const s = readStored();
  if (patch.host !== undefined) s.host = patch.host.trim();
  if (patch.port !== undefined) s.port = patch.port;
  if (patch.secure !== undefined) s.secure = patch.secure;
  if (patch.user !== undefined) s.user = patch.user.trim();
  if (patch.from !== undefined) s.from = patch.from.trim();
  if (patch.notifyEmail !== undefined) s.notifyEmail = patch.notifyEmail.trim();
  if (patch.pass !== undefined) s.passEnc = patch.pass ? encryptSecret(patch.pass) : undefined;
  setSetting(KEY, JSON.stringify(s));
}
