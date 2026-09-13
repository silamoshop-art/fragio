/**
 * Self-Service-Kauf per RECHNUNG (Überweisung / PayPal) — halbautomatisch.
 *
 * Ablauf: Kunde bestellt -> Bot wird als „paused" (noch nicht freigeschaltet)
 * mit Rechnungsdaten angelegt -> eine Rechnung wird erzeugt und per E-Mail
 * geschickt (IBAN + Verwendungszweck) -> der Kunde überweist / zahlt per PayPal
 * -> der Betreiber markiert die Rechnung im Admin als bezahlt, was die
 * Freischaltung + Provisionierung auslöst (siehe routes/admin.ts).
 *
 * Es wird bewusst NICHT vor der Zahlung gecrawlt (kein Missbrauch, keine Last für
 * unbezahlte Bestellungen) — der Crawl passiert erst bei „bezahlt".
 */
import { createBot, updateBot, getBot, OPERATOR_TENANT_ID } from "../db/repo.js";
import { planById, planName } from "../billing/plans.js";
import { generateExtraInvoice, currentPeriod } from "../billing/invoice.js";
import { operatorConfig } from "../config/operator.js";
import { epcQrDataUrl } from "../util/epc-qr.js";

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
  paypal: string;
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
    periodLabel: currentPeriod().label,
  });
  const invoiceNumber = res.invoice?.invoice_number || "";

  const op = operatorConfig();
  const qrDataUrl = await epcQrDataUrl({
    name: op.bank.accountHolder,
    iban: op.bank.iban,
    bic: op.bank.bic,
    amountCents: monthly,
    reference: invoiceNumber,
  });
  return {
    invoiceNumber,
    amountCents: monthly,
    currency: op.currency || "EUR",
    reference: invoiceNumber,
    bank: op.bank,
    paypal: op.paypal || "",
    qrDataUrl,
  };
}
