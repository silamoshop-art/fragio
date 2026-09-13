/**
 * Automatische Provisionierung nach bestätigter Zahlung (Self-Service-Kauf).
 *
 * Ablauf (vollautomatisch, ohne Zutun des Betreibers):
 *   1. Login-Zugang fürs Kundenportal anlegen (Passwort generieren + hashen).
 *   2. Website crawlen + indexieren.
 *   3. Prüfen, ob genug Inhalt gefunden wurde (mind. eine Seite mit Text).
 *   4. Dem Kunden die Zugangsdaten + Dashboard-Link mailen.
 *   5. Dem Betreiber eine Zusammenfassung der Kundendaten mailen.
 *
 * Wird als fire-and-forget aus dem Stripe-Webhook aufgerufen; Fehler werden
 * geloggt und lösen eine „bitte manuell prüfen"-Mail an den Betreiber aus,
 * damit nie ein bezahlter Kunde unbemerkt hängen bleibt.
 */
import crypto from "node:crypto";
import { getBot, upsertBotUser } from "../db/repo.js";
import { hashPassword } from "../crypto/password.js";
import { crawlAndIndex } from "../crawler/index.js";
import { sendEmail, sendOperatorEmail } from "../notify/email.js";
import { backendBase } from "../util/embed.js";
import { planName } from "../billing/plans.js";

/** Lesbares, sicheres Passwort (ohne leicht verwechselbare Zeichen), gruppiert. */
export function generatePassword(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(15);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += alphabet[bytes[i] % alphabet.length];
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}`;
}

function domainOf(bot: { crawl_start_url: string | null; name: string }): string {
  const raw = bot.crawl_start_url || bot.name || "";
  try {
    return new URL(raw).hostname.replace(/^www\./i, "");
  } catch {
    return raw;
  }
}

export async function provisionPaidBot(botId: string, email: string): Promise<void> {
  const bot = getBot(botId);
  if (!bot) throw new Error("Bot nicht gefunden: " + botId);

  // 1) Login-Zugang fürs Portal anlegen (Passwort im Klartext nur für die E-Mail).
  const password = generatePassword();
  upsertBotUser(botId, email, hashPassword(password));

  const portalUrl = backendBase() + "/portal/";
  const domain = domainOf(bot);
  const plan = planName(bot.plan) || "";

  // 2) + 3) Crawlen und prüfen.
  let pages = 0;
  let ok = false;
  let errMsg = "";
  try {
    const res = await crawlAndIndex(bot);
    pages = res.pages;
    ok = res.pages >= 1 && res.chunks > 0;
  } catch (e) {
    errMsg = (e as Error).message;
  }

  // 4) Kunden-Mail mit Zugangsdaten.
  const subject = ok
    ? "Dein Fragio-Chatbot ist startklar"
    : "Dein Fragio-Zugang ist da — wir prüfen deine Website noch";
  const access =
    `So kommst du in dein Dashboard:\n` +
    `  Link:     ${portalUrl}\n` +
    `  E-Mail:   ${email}\n` +
    `  Passwort: ${password}\n\n` +
    `Bitte ändere das Passwort nach dem ersten Login.`;
  const body = ok
    ? `Hallo,\n\nvielen Dank für deine Bestellung! Dein Chatbot für ${domain} ist eingerichtet ` +
      `und deine Website wurde eingelesen (${pages} Seiten).\n\n${access}\n\n` +
      `Den Einbau-Code (eine einzige Zeile für deine Website) findest du in deinem Dashboard.\n\n` +
      `Viele Grüße\nFragio`
    : `Hallo,\n\nvielen Dank für deine Bestellung! Dein Zugang ist bereits aktiv.\n\n${access}\n\n` +
      `Beim automatischen Einlesen deiner Website (${domain}) haben wir noch nicht genug ` +
      `Inhalte gefunden${errMsg ? ` (${errMsg})` : ""}. Wir sehen uns das persönlich an und ` +
      `melden uns in Kürze — du musst nichts weiter tun.\n\nViele Grüße\nFragio`;
  try {
    await sendEmail(email, subject, body);
  } catch (e) {
    console.error("Kunden-Mail fehlgeschlagen:", (e as Error).message);
  }

  // 5) Betreiber-Mail mit den Kundendaten.
  try {
    await sendOperatorEmail(
      `Neuer zahlender Kunde: ${domain}${plan ? ` (${plan})` : ""}`,
      `Neue Self-Service-Bestellung:\n\n` +
        `  Domain:  ${domain}\n` +
        `  E-Mail:  ${email}\n` +
        `  Tarif:   ${plan}\n` +
        `  Bot-ID:  ${botId}\n` +
        `  Crawl:   ${ok ? pages + " Seiten — OK" : "FEHLGESCHLAGEN" + (errMsg ? " — " + errMsg : "")}\n\n` +
        (ok
          ? `Alles wurde automatisch erledigt (Zugang angelegt, Website eingelesen, Kunde informiert).`
          : `⚠️ Bitte manuell prüfen und die Website des Kunden nachrichten/erneut crawlen.`),
    );
  } catch (e) {
    console.error("Betreiber-Mail fehlgeschlagen:", (e as Error).message);
  }
}
