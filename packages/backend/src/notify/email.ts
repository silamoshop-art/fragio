/**
 * E-Mail-Versand (Betreiber-Benachrichtigungen, Support-Weiterleitung, Rechnungen, Mahnungen).
 *
 * Generisches SMTP via nodemailer: Sind SMTP_HOST/SMTP_USER/SMTP_PASS gesetzt
 * (config.smtpEnabled), wird echt verschickt — mit jedem Anbieter (eigenes Postfach,
 * Mailbox.org, Gmail, Resend/Postmark per SMTP …). Fehlt die Konfiguration, fällt der
 * Versand auf einen Log-Stub zurück (Dev/vor Go-Live). Die Aufrufer bleiben identisch.
 */
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../config.js";
import { operatorConfig } from "../config/operator.js";

export interface EmailAttachment {
  filename: string;
  path: string; // lokaler Pfad (z. B. Rechnungs-PDF)
}

let _transport: Transporter | null = null;
function transport(): Transporter | null {
  if (!config.smtpEnabled) return null;
  if (_transport) return _transport;
  _transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.smtpSecure, // true => 465 (implizites TLS), false => STARTTLS auf 587
    auth: { user: config.SMTP_USER!, pass: config.SMTP_PASS! },
  });
  return _transport;
}

/**
 * Absenderadresse: explizit gesetztes SMTP_FROM, sonst SMTP_USER, sonst die
 * Support-Adresse aus operator.config.json (als sinnvoller Fallback).
 */
function fromAddress(): string {
  if (config.SMTP_FROM) return config.SMTP_FROM;
  const op = operatorConfig();
  const addr = config.SMTP_USER || op.supportEmail;
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
        "\n    (SMTP nicht konfiguriert — setze SMTP_HOST/SMTP_USER/SMTP_PASS in der .env für echten Versand.)",
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

/** Benachrichtigung an DICH (Betreiber, ADMIN_EMAIL). */
export async function sendOperatorEmail(subject: string, body: string): Promise<void> {
  return sendEmail(config.ADMIN_EMAIL, subject, body);
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
