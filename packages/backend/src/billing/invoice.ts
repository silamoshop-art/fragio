/**
 * Rechnungserstellung.
 *
 * - VORAUSKASSE: Die monatliche Rechnung wird VOR dem Leistungszeitraum erstellt
 *   (z. B. Ende Juli die August-Rechnung) — siehe `upcomingPeriod()` + Cron am 25.
 * - Zusatzrechnungen: frei definierbare Einzelrechnung (Betrag, Beschreibung,
 *   Zeitraum) außerhalb des Monatszyklus — z. B. Proration bei Tarifwechsel.
 * - Fortlaufende, lückenlose Rechnungsnummer pro Kalenderjahr (Ausstellungsdatum),
 *   transaktionssicher über `nextInvoiceNumber()` — gilt für Monats- UND Zusatzrechnungen.
 * - Fehlt eine Rechnungsadresse, wird KEINE Rechnung mit Lücken erzeugt, sondern ein
 *   InvoiceDataError geworfen (Aufrufer loggt + zeigt es im Dashboard).
 * - E-Mail-Versand (echt via SMTP, sonst Log-Stub) nur wenn pro Bot aktiviert.
 */
import fs from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import { config } from "../config.js";
import { planName } from "./plans.js";
import { operatorConfig } from "../config/operator.js";
import { sendEmail } from "../notify/email.js";
import {
  getInvoiceForBotPeriod,
  nextInvoiceNumber,
  insertInvoice,
  markInvoiceSent,
  botHasInvoice,
  clearSetupFeeDue,
  type BotRow,
  type InvoiceRow,
} from "../db/repo.js";

export class InvoiceDataError extends Error {}

interface Period {
  period: string;
  label: string;
  year: number;
}

/** Vormonat relativ zu `now` (Alt-Logik/Referenz; nicht mehr für den Regellauf). */
export function previousPeriod(now = new Date()): Period {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() - 1);
}

/** Kommender Monat relativ zu `now` — Basis der Vorauskasse (Ende Juli → August). */
export function upcomingPeriod(now = new Date()): Period {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth() + 1);
}

/** Aktueller Kalendermonat von `now`. */
export function currentPeriod(now = new Date()): Period {
  return monthPeriod(now.getUTCFullYear(), now.getUTCMonth());
}

function monthPeriod(year: number, monthIndex: number): Period {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const mm = String(m + 1).padStart(2, "0");
  return { period: `${y}-${mm}`, label: `01.${mm}.–${lastDay}.${mm}.${y}`, year: y };
}

/**
 * Anteiliger Betrag (Proration) für den Rest des Kalendermonats ab `from`
 * (inklusive dem Tag von `from`). Für Tarifwechsel mitten im Monat.
 */
export function prorateCents(monthlyCents: number, from = new Date()): {
  cents: number;
  remainingDays: number;
  daysInMonth: number;
} {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const remainingDays = daysInMonth - from.getUTCDate() + 1; // inkl. heutigem Tag
  const cents = Math.round((monthlyCents * remainingDays) / daysInMonth);
  return { cents, remainingDays, daysInMonth };
}

const invoicesDir = path.join(config.repoRoot, "data", "invoices");

export interface GenerateResult {
  created: boolean;
  invoice?: InvoiceRow;
  reason?: string;
}

interface LineItem {
  label: string;
  cents: number;
}

/**
 * Monats-Abo-Rechnung im VORAUS erstellen (Standard: kommender Monat).
 * Wirft InvoiceDataError bei fehlenden Pflicht-Kundendaten.
 */
export async function generateInvoiceForBot(
  bot: BotRow,
  when = new Date(),
): Promise<GenerateResult> {
  const { period, label } = upcomingPeriod(when);

  const existing = getInvoiceForBotPeriod(bot.id, period);
  if (existing) return { created: false, invoice: existing, reason: "bereits vorhanden" };

  requireBillingData(bot);
  if (!bot.price_cents || bot.price_cents <= 0) {
    throw new InvoiceDataError(`Rechnung für Bot ${bot.id} nicht möglich: kein Preis gesetzt.`);
  }

  // Einrichtungsgebühr NUR auf der allerersten Rechnung dieses Bots.
  const chargeSetup = !botHasInvoice(bot.id) && bot.setup_fee_due_cents > 0;
  const items: LineItem[] = [
    { label: `${planName(bot.plan) || "SiteBot-Abo"} — Leistungszeitraum ${label}`, cents: bot.price_cents },
  ];
  if (chargeSetup) {
    items.push({ label: "Einmalige Einrichtungsgebühr (Erstrechnung)", cents: bot.setup_fee_due_cents });
  }

  const result = await writeInvoice(bot, {
    period,
    periodLabel: label,
    items,
    plan: planName(bot.plan) || bot.plan,
    when,
  });
  if (chargeSetup) clearSetupFeeDue(bot.id);
  return result;
}

export interface ExtraInvoiceInput {
  amountCents: number;
  description: string;
  periodLabel: string; // freier Zeitraum-Text, z. B. "Juli 2026 (anteilig)"
}

/**
 * Freie Zusatzrechnung außerhalb des Monatszyklus (z. B. Proration, Sonderposten).
 * Nutzt denselben lückenlosen Nummernzähler. `period` ist synthetisch-eindeutig,
 * damit die UNIQUE(bot_id, period)-Regel nicht mit Monatsrechnungen kollidiert.
 */
export async function generateExtraInvoice(
  bot: BotRow,
  input: ExtraInvoiceInput,
  when = new Date(),
): Promise<GenerateResult> {
  requireBillingData(bot);
  if (!input.amountCents || input.amountCents <= 0) {
    throw new InvoiceDataError("Zusatzrechnung: Betrag muss größer 0 sein.");
  }
  if (!input.description.trim()) {
    throw new InvoiceDataError("Zusatzrechnung: Beschreibung fehlt.");
  }
  const period = `extra-${Date.now()}`;
  return writeInvoice(bot, {
    period,
    periodLabel: input.periodLabel || "Einzelrechnung",
    items: [{ label: input.description.trim(), cents: input.amountCents }],
    plan: "Zusatzrechnung",
    when,
  });
}

function requireBillingData(bot: BotRow): void {
  if (!bot.customer_name || !bot.customer_address) {
    throw new InvoiceDataError(
      `Rechnung für Bot ${bot.id} nicht möglich: Rechnungsdaten des Kunden (Name/Adresse) fehlen.`,
    );
  }
}

/** Gemeinsamer Kern: Nummer ziehen, PDF schreiben, Datensatz anlegen, optional mailen.
 *  Rechnungsempfänger = KUNDENDATEN DES BOTS (pro Bot eigenständig). */
async function writeInvoice(
  bot: BotRow,
  args: { period: string; periodLabel: string; items: LineItem[]; plan: string | null; when: Date },
): Promise<GenerateResult> {
  const op = operatorConfig();
  const currency = op.currency || "EUR";
  const totalCents = args.items.reduce((s, it) => s + it.cents, 0);

  // Rechnungsnummer nach AUSSTELLUNGSJAHR (nicht Leistungszeitraum) — juristisch korrekt.
  const number = nextInvoiceNumber(args.when.getUTCFullYear());
  fs.mkdirSync(invoicesDir, { recursive: true });
  const pdfPath = path.join(invoicesDir, `${number}.pdf`);

  await renderPdf(pdfPath, {
    number,
    dateLabel: args.when.toLocaleDateString("de-AT"),
    periodLabel: args.periodLabel,
    issuerName: op.name,
    issuerAddress: op.address,
    issuerVat: op.uid,
    issuerTaxNote: op.taxNote,
    issuerBank: op.bank,
    customerName: bot.customer_name!,
    customerAddress: bot.customer_address!,
    customerVat: bot.customer_vat,
    items: args.items,
    totalCents,
    currency,
  });

  const id = insertInvoice({
    invoice_number: number,
    bot_id: bot.id,
    tenant_id: bot.tenant_id,
    period: args.period,
    period_label: args.periodLabel,
    amount_cents: totalCents,
    currency,
    plan: args.plan,
    pdf_path: pdfPath,
    sent: 0,
  });

  // Echter E-Mail-Versand nur wenn pro Bot aktiviert und Empfänger (des Bots) vorhanden.
  if (bot.auto_send_invoice && bot.customer_email) {
    try {
      await sendEmail(
        bot.customer_email,
        `Rechnung ${number}`,
        [
          `Guten Tag ${bot.customer_name},`,
          ``,
          `im Anhang findest du die Rechnung ${number} (Leistungszeitraum ${args.periodLabel}) ` +
            `über ${money(totalCents, currency)}.`,
          ``,
          `Mit freundlichen Grüßen`,
          op.name,
        ].join("\n"),
        [{ filename: `Rechnung-${number}.pdf`, path: pdfPath }],
      );
      markInvoiceSent(id);
    } catch (e) {
      console.error(`✉️  Rechnungsversand ${number} fehlgeschlagen:`, (e as Error).message);
    }
  }

  const invoice = getInvoiceForBotPeriod(bot.id, args.period)!;
  return { created: true, invoice };
}

interface PdfData {
  number: string;
  dateLabel: string;
  periodLabel: string;
  issuerName: string;
  issuerAddress: string;
  issuerVat: string;
  issuerTaxNote: string;
  issuerBank: { accountHolder: string; iban: string; bic: string; bankName: string };
  customerName: string;
  customerAddress: string;
  customerVat: string | null;
  items: LineItem[];
  totalCents: number;
  currency: string;
}

function money(cents: number, currency: string): string {
  return (cents / 100).toFixed(2).replace(".", ",") + " " + currency;
}

function renderPdf(filePath: string, d: PdfData): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 56 });
    const stream = fs.createWriteStream(filePath);
    stream.on("finish", () => resolve());
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    // Kopf: Leistender (aus operator.config.json)
    doc.fontSize(18).fillColor("#000").text(d.issuerName);
    doc.fontSize(10).fillColor("#555");
    d.issuerAddress.split("\n").forEach((line) => doc.text(line));
    if (d.issuerVat) doc.text(`UID: ${d.issuerVat}`);
    doc.moveDown(2);

    // Empfänger
    doc.fillColor("#000").fontSize(11).text("Rechnungsempfänger:");
    doc.fontSize(10);
    doc.text(d.customerName);
    d.customerAddress.split("\n").forEach((l) => doc.text(l));
    if (d.customerVat) doc.text(`UID: ${d.customerVat}`);
    doc.moveDown(1.5);

    // Meta
    doc.fontSize(16).text("Rechnung", { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(10);
    doc.text(`Rechnungsnummer: ${d.number}`);
    doc.text(`Rechnungsdatum: ${d.dateLabel}`);
    doc.text(`Leistungszeitraum: ${d.periodLabel}`);
    doc.moveDown(1.5);

    // Positionen
    const line = (label: string, cents: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica");
      const y = doc.y;
      doc.text(label, 56, y, { width: 330 });
      doc.text(money(cents, d.currency), 400, y, { width: 140, align: "right" });
      doc.moveDown(0.6);
    };
    const y0 = doc.y;
    doc.font("Helvetica-Bold");
    doc.text("Position", 56, y0);
    doc.text("Betrag", 400, y0, { width: 140, align: "right" });
    doc.font("Helvetica");
    doc.moveTo(56, doc.y + 2).lineTo(540, doc.y + 2).stroke("#ccc");
    doc.moveDown(0.6);

    for (const it of d.items) line(it.label, it.cents);
    doc.moveTo(56, doc.y).lineTo(540, doc.y).stroke("#ccc");
    doc.moveDown(0.5);
    line("Gesamtbetrag", d.totalCents, true);
    doc.font("Helvetica");

    // Zahlungsinformationen (Bank aus operator.config.json)
    doc.moveDown(1.5).fontSize(10).fillColor("#000").text("Zahlbar auf folgendes Konto:");
    doc.fontSize(9).fillColor("#555");
    doc.text(`Kontoinhaber: ${d.issuerBank.accountHolder}`);
    doc.text(`IBAN: ${d.issuerBank.iban}    BIC: ${d.issuerBank.bic}`);
    doc.text(`Bank: ${d.issuerBank.bankName}`);
    doc.text(`Verwendungszweck: ${d.number}`);

    doc.moveDown(1.5).fontSize(9).fillColor("#777");
    if (d.issuerTaxNote) doc.text(d.issuerTaxNote);
    doc.moveDown(0.5);
    doc.text("Vielen Dank für die Zusammenarbeit.");

    doc.end();
  });
}
