/**
 * E-Mail-Versand (Betreiber-Benachrichtigungen, Support-Weiterleitung, Rechnungen, Mahnungen).
 *
 * Generisches SMTP via nodemailer: Sind SMTP_HOST/SMTP_USER/SMTP_PASS gesetzt
 * (config.smtpEnabled), wird echt verschickt — mit jedem Anbieter (eigenes Postfach,
 * Mailbox.org, Gmail, Resend/Postmark per SMTP …). Fehlt die Konfiguration, fällt der
 * Versand auf einen Log-Stub zurück (Dev/vor Go-Live). Die Aufrufer bleiben identisch.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { operatorConfig } from "../config/operator.js";
import { getMailConfig, mailConfigSignature } from "./mail-config.js";

export interface EmailAttachment {
  filename: string;
  path: string; // lokaler Pfad (z. B. Rechnungs-PDF)
}

let _transport: Transporter | null = null;
let _sig = "";
/** Transport aus der EFFEKTIVEN Config bauen; bei Änderung (Admin) neu erzeugen. */
function transport(): Transporter | null {
  const mc = getMailConfig();
  if (!mc.enabled) return null;
  const sig = mailConfigSignature();
  if (_transport && sig === _sig) return _transport;
  _transport = nodemailer.createTransport({
    host: mc.host,
    port: mc.port,
    secure: mc.secure, // true => 465 (implizites TLS), false => STARTTLS auf 587
    auth: { user: mc.user, pass: mc.pass },
    // IPv4 erzwingen: auf Dual-Stack-Servern (z. B. netcup-VPS) versucht Node oft
    // zuerst IPv6; ist der IPv6-Ausgang zum Mailserver nicht sauber geroutet, führt
    // das zu „Connection timeout". Über IPv4 ist SMTP praktisch immer erreichbar.
    // (family wird von nodemailer an net.connect durchgereicht, ist aber nicht typisiert.)
    family: 4,
    // Schnell scheitern statt lange hängen (z. B. wenn der Server ausgehende
    // SMTP-Ports blockiert -> Connection Timeout).
    connectionTimeout: 12000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  } as Parameters<typeof nodemailer.createTransport>[0] & { family: number });
  _sig = sig;
  return _transport;
}

/**
 * Absenderadresse: explizit gesetztes "From", sonst SMTP-User, sonst die
 * Support-Adresse aus der Betreiberkonfiguration (als sinnvoller Fallback).
 */
function fromAddress(): string {
  const mc = getMailConfig();
  if (mc.from) return mc.from;
  const op = operatorConfig();
  const addr = mc.user || op.supportEmail;
  return op.name ? `${op.name} <${addr}>` : addr;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  attachments: EmailAttachment[] = [],
): Promise<void> {
  const t = transport();
  if (!t) {
    // Stub-Fallback: nur loggen (kein SMTP konfiguriert).
    const att = attachments.length
      ? `\n    [Anhang: ${attachments.map((a) => a.filename).join(", ")}]`
      : "";
    console.log(
      `✉️  [E-Mail-STUB an ${to}] ${subject}\n` +
        body.split("\n").map((l) => "    " + l).join("\n") +
        att +
        "\n    (SMTP nicht konfiguriert — im Admin unter Einstellungen / E-Mail-Versand eintragen oder SMTP_HOST/SMTP_USER/SMTP_PASS in der .env setzen.)",
    );
    return;
  }
  await t.sendMail({
    from: fromAddress(),
    to,
    subject,
    text: body,
    attachments: attachments.map((a) => ({ filename: a.filename, path: a.path })),
  });
  console.log(`✉️  E-Mail an ${to} versendet: „${subject}"${attachments.length ? " (mit Anhang)" : ""}`);
}

/** Benachrichtigung an DICH (Betreiber) — an die im Admin gesetzte Empfängeradresse. */
export async function sendOperatorEmail(subject: string, body: string): Promise<void> {
  return sendEmail(getMailConfig().notifyEmail, subject, body);
}

/** SMTP-Verbindung prüfen (für einen Health-/Test-Endpoint). Wirft bei Fehlern. */
export async function verifySmtp(): Promise<{ configured: boolean; ok: boolean; error?: string }> {
  const t = transport();
  if (!t) return { configured: false, ok: false };
  try {
    await t.verify();
    return { configured: true, ok: true };
  } catch (e) {
    return { configured: true, ok: false, error: (e as Error).message };
  }
}
