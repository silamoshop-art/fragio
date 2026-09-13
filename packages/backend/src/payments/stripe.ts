/**
 * Stripe-Integration — VORBEREITET, standardmäßig AUS (config.stripeEnabled).
 *
 * Architektur, damit später nur der Schalter STRIPE_ENABLED=true (+ Keys) nötig ist:
 *  - stripeEnabled(): steuert im Portal, ob ein Tarifklick eine Anfrage speichert
 *    (aus) oder einen Stripe-Checkout startet (an).
 *  - createCheckoutSession(): erzeugt die Checkout-Session (TODO: Stripe-SDK).
 *    In metadata gehören botId/planId/variant, damit der Webhook den Tarif
 *    nach bestätigter Zahlung automatisch freischalten kann.
 *  - handleWebhook(): verifiziert das Event und schaltet bei
 *    checkout.session.completed den Tarif frei (applyPlanToBot) + Anfrage erledigt.
 *
 * Solange STRIPE_ENABLED=false ist, wird nichts davon aufgerufen.
 */
import Stripe from "stripe";
import { config } from "../config.js";
import { planById, applyDiscount, type DiscountType } from "../billing/plans.js";
import { updateBot, recordPlanChange, getBot, createBot, OPERATOR_TENANT_ID } from "../db/repo.js";
import { operatorConfig } from "../config/operator.js";
import { backendBase } from "../util/embed.js";
import { provisionPaidBot } from "../onboarding/provision.js";

export function stripeEnabled(): boolean {
  return config.stripeEnabled;
}

// Lazy-initialisierter Stripe-Client — erst wenn STRIPE_ENABLED=true UND ein Key da ist.
let _stripe: Stripe | null = null;
function stripe(): Stripe {
  if (!config.STRIPE_SECRET_KEY) {
    throw new Error("Stripe ist aktiviert, aber STRIPE_SECRET_KEY fehlt in der .env.");
  }
  if (!_stripe) _stripe = new Stripe(config.STRIPE_SECRET_KEY);
  return _stripe;
}

export interface CheckoutParams {
  /** Vorhandener Bot (Portal-Upgrade). Bei Self-Service-Signup leer — dann `url`. */
  botId?: string;
  planId: string;
  variant: string;
  monthlyCents: number;
  setupCents: number;
  /** Self-Service-Registrierung: Website-URL + E-Mail; der Bot entsteht erst nach Zahlung. */
  url?: string;
  email?: string;
  signup?: boolean;
  successUrl?: string;
  cancelUrl?: string;
}

export async function createCheckoutSession(params: CheckoutParams): Promise<{ url: string }> {
  const s = stripe();
  const currency = (operatorConfig().currency || "EUR").toLowerCase();
  const base = backendBase();

  // Monatliches Abo als wiederkehrende Position.
  const line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency,
        product_data: { name: `SiteBot-Abo — ${params.planId} (${params.variant})` },
        unit_amount: params.monthlyCents,
        recurring: { interval: "month" },
      },
      quantity: 1,
    },
  ];
  // Einmalige Einrichtungsgebühr als einmalige Position (erste Rechnung).
  if (params.setupCents > 0) {
    line_items.push({
      price_data: {
        currency,
        product_data: { name: "Einmalige Einrichtungsgebühr" },
        unit_amount: params.setupCents,
      },
      quantity: 1,
    });
  }

  const metadata: Record<string, string> = {
    planId: params.planId,
    variant: params.variant,
    monthlyCents: String(params.monthlyCents),
  };
  if (params.botId) metadata.botId = params.botId;
  if (params.signup) metadata.signup = "1";
  if (params.url) metadata.url = params.url;
  if (params.email) metadata.email = params.email;

  const session = await s.checkout.sessions.create({
    mode: "subscription",
    line_items,
    metadata,
    subscription_data: { metadata },
    ...(params.email ? { customer_email: params.email } : {}),
    success_url: params.successUrl || `${base}/portal/?checkout=success`,
    cancel_url: params.cancelUrl || `${base}/portal/?checkout=cancel`,
  });
  if (!session.url) throw new Error("Stripe: keine Checkout-URL erhalten.");
  return { url: session.url };
}

/**
 * Stripe-Webhook verarbeiten (Raw-Body + Signatur). Bei bezahltem Checkout wird
 * der Tarif automatisch freigeschaltet — dieselbe Stelle wie der manuelle Button.
 * Wirft bei ungültiger Signatur (Aufrufer -> 400).
 */
export function handleWebhook(rawBody: Buffer, signature: string): { received: boolean } {
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET fehlt in der .env.");
  }
  const event = stripe().webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const md = session.metadata || {};
    if (md.signup === "1" && md.url && md.planId && md.monthlyCents) {
      // Self-Service-Kauf: Bot ERST JETZT (nach bezahlter Zahlung) anlegen,
      // Tarif freischalten und vollautomatisch provisionieren (Zugang, Crawl,
      // Prüfung, Mails). Fire-and-forget, damit Stripe sofort ein 200 erhält.
      const email = md.email || session.customer_email || "";
      const host = signupHost(md.url);
      const bot = createBot({
        tenantId: OPERATOR_TENANT_ID,
        name: host,
        startUrl: md.url,
        maxPages: 50,
        allowedOrigins: host ? [host] : [],
      });
      applyPlanToBot(bot.id, md.planId, Number(md.monthlyCents));
      if (email) {
        void provisionPaidBot(bot.id, email).catch((e) =>
          console.error("Provisionierung fehlgeschlagen:", (e as Error).message),
        );
      }
    } else if (md.botId && md.planId && md.monthlyCents) {
      // Bestehender Bot (Portal-Upgrade): nur den Tarif freischalten.
      applyPlanToBot(md.botId, md.planId, Number(md.monthlyCents));
    }
  }
  return { received: true };
}

/** Host aus der Signup-URL (für Bot-Name + Domain-Whitelist). */
function signupHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

/**
 * Tarif eines Bots freischalten (aus Anfrage oder Stripe-Metadaten). EINE Stelle,
 * die sowohl der manuelle „Freischalten"-Button als auch der Stripe-Webhook nutzen.
 */
export function applyPlanToBot(botId: string, planId: string, monthlyCents: number): void {
  const plan = planById(planId);
  if (!plan) throw new Error("Unbekannter Tarif: " + planId);
  const bot = getBot(botId);
  const from = bot?.plan ?? null;
  // Basispreis merken, individuellen Rabatt anwenden -> tatsächlich berechneter Preis.
  const price = applyDiscount(
    monthlyCents,
    (bot?.discount_type ?? null) as DiscountType,
    bot?.discount_value ?? 0,
  );
  updateBot(botId, {
    monthly_quota: plan.limit,
    plan: plan.id,
    base_price_cents: monthlyCents,
    price_cents: price,
    is_paying: 1,
  });
  recordPlanChange(botId, from, plan.id, price);
}

/** Rabatt neu anwenden, wenn der Operator ihn ändert (Preis aus Basispreis). */
export function recomputeBotPrice(botId: string): void {
  const bot = getBot(botId);
  if (!bot || !bot.base_price_cents) return;
  const price = applyDiscount(
    bot.base_price_cents,
    (bot.discount_type ?? null) as DiscountType,
    bot.discount_value ?? 0,
  );
  updateBot(botId, { price_cents: price });
}

// Skelett für später:
// export async function handleWebhook(rawBody, signature): Promise<void> {
//   // stripe.webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET)
//   // if event.type === 'checkout.session.completed':
//   //   const { botId, planId } = session.metadata;
//   //   applyPlanToBot(botId, planId, session.amount_total ...); markPlanChangeRequestDone(...)
// }
