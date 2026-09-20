/**
 * Self-Service-Kauf per RECHNUNG (Banküberweisung) — halbautomatisch.
 *
 * Ablauf: Kunde bestellt -> Bot wird als „paused" (noch nicht freigeschaltet)
 * mit Rechnungsdaten angelegt -> eine Rechnung wird erzeugt und per E-Mail
 * geschickt (IBAN + Verwendungszweck) -> der Kunde überweist den Betrag
 * -> der Betreiber markiert die Rechnung im Admin als bezahlt, was die
 * Freischaltung + Provisionierung auslöst (siehe routes/admin.ts).
 *
 * Es wird bewusst NICHT vor der Zahlung gecrawlt (kein Missbrauch, keine Last für
 * unbezahlte Bestellungen) — der Crawl passiert erst bei „bezahlt".
 */
import { createBot, updateBot, getBot, OPERATOR_TENANT_ID } from "../db/repo.js";
import { planById, planName, getPricing } from "../billing/plans.js";
import { generateExtraInvoice, dayPeriod } from "../billing/invoice.js";
import { operatorConfig } from "../config/operator.js";
import { epcQrDataUrl } from "../util/epc-qr.js";
import { sendOperatorEmail } from "../notify/email.js";

export interface OrderInput {
  email: string;
  name: string;
  address: string;
  vat?: string | null;
  url: string;
  planId: string;
}

export interface OrderResult {
  invoiceNumber: string;
  amountCents: number;
  currency: string;
  reference: string;
  bank: { accountHolder: string; iban: string; bic: string; bankName: string };
  /** EPC-/Giro-QR als data:-URL (Betrag + Verwendungszweck vorbefüllt) — null bei Platzhalter-IBAN. */
  qrDataUrl: string | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

export async function createOrder(input: OrderInput): Promise<OrderResult> {
  const plan = planById(input.planId);
  if (!plan) throw new Error("Unbekannter Tarif.");
  const monthly = plan.setup.monthlyCents;
  // Einmalige Einrichtungsgebühr NUR bei Neubestellung und nur wenn im Admin aktiviert.
  // Bestandskunden zahlen sie dadurch nicht erneut (Folgerechnungen enthalten sie nie).
  const pricing = getPricing();
  const setupCents = pricing.setupFeeEnabled ? pricing.setupFeeCents : 0;
  const total = monthly + setupCents;

  const host = hostOf(input.url);
  const bot = createBot({
    tenantId: OPERATOR_TENANT_ID,
    name: host,
    startUrl: input.url,
    maxPages: 50,
    allowedOrigins: host ? [host] : [],
  });
  // Als „ausstehend" markieren + Tarif/Preis/Rechnungsdaten hinterlegen.
  updateBot(bot.id, {
    status: "paused",
    is_paying: 0,
    plan: plan.id,
    price_cents: monthly,
    base_price_cents: monthly,
    customer_name: input.name,
    customer_address: input.address,
    customer_email: input.email,
    customer_vat: input.vat || null,
    auto_send_invoice: 1, // Rechnung automatisch per E-Mail schicken
  });

  const fresh = getBot(bot.id)!;
  const res = await generateExtraInvoice(fresh, {
    amountCents: monthly,
    description: `Fragio ${planName(plan.id)} — Monatsbeitrag`,
    // Abo läuft ab dem Bestelltag (nicht ab Monatsanfang).
    periodLabel: dayPeriod().label,
    extraItems: setupCents > 0 ? [{ label: "Einmalige Einrichtungsgebühr", cents: setupCents }] : undefined,
  });
  const invoiceNumber = res.invoice?.invoice_number || "";

  // Verwendungszweck identisch zur Rechnung: Rechnungsnummer + Firmen-/Kundenname
  // (wird beim QR-Scan automatisch vorbefüllt, bei manueller Überweisung eindeutig).
  const reference = `${invoiceNumber} ${input.name}`.slice(0, 140);

  const op = operatorConfig();
  const qrDataUrl = await epcQrDataUrl({
    name: op.bank.accountHolder,
    iban: op.bank.iban,
    bic: op.bank.bic,
    amountCents: total, // Gesamtbetrag inkl. evtl. Einrichtungsgebühr
    reference,
  });

  // Betreiber über die neue Bestellung informieren (fire-and-forget, blockiert den
  // Checkout nicht). Geht an die im Admin eingestellte Benachrichtigungsadresse.
  void sendOperatorEmail(
    `Neue Bestellung: ${planName(plan.id)} — ${input.name}`,
    [
      `Es ist eine neue Bestellung eingegangen:`,
      ``,
      `Tarif:     ${planName(plan.id)}`,
      `Kunde:     ${input.name} <${input.email}>`,
      `Website:   ${input.url}`,
      `Betrag:    ${(total / 100).toFixed(2)} ${op.currency || "EUR"} (Rechnung ${invoiceNumber})`,
      `Anschrift: ${input.address}`,
      ``,
      `Sobald die Zahlung eingegangen ist, im Dashboard als bezahlt markieren — das schaltet den Bot frei.`,
    ].join("\n"),
  ).catch(() => {});

  return {
    invoiceNumber,
    amountCents: total,
    currency: op.currency || "EUR",
    reference,
    bank: op.bank,
    qrDataUrl,
  };
}
