/**
 * Lemon Squeezy — Zahlungsanbieter (Merchant of Record) für den Self-Service-Kauf.
 *
 * Warum LS statt eigener Zahlung: LS ist lizenzierter Händler, hostet den Checkout
 * (KEINE Kartendaten berühren je unseren Server -> kein PCI-Scope) und übernimmt die
 * USt.-Abrechnung. Wir übergeben nur Metadaten (Website-URL, Tarif, E-Mail); nach
 * bezahltem Abo meldet ein signierter Webhook „subscription_created", woraufhin der
 * Bot angelegt, freigeschaltet und automatisch provisioniert wird.
 *
 * Aktivierung ausschließlich über die .env (LEMONSQUEEZY_ENABLED=true + API-Key +
 * Store-ID + Webhook-Secret + Variant-IDs je Tarif) — kein Code-Eingriff nötig.
 */
import crypto from "node:crypto";
import { config } from "../config.js";
import { planById } from "../billing/plans.js";
import { applyPlanToBot } from "./stripe.js";
import { createBot, getSetting, setSetting, OPERATOR_TENANT_ID } from "../db/repo.js";
import { provisionPaidBot } from "../onboarding/provision.js";
import { backendBase } from "../util/embed.js";

const LS_API = "https://api.lemonsqueezy.com/v1";

export function lsEnabled(): boolean {
  return config.lemonSqueezyEnabled;
}

/** In Lemon Squeezy angelegte Variant-ID (Abo-Produkt) je Tarif. */
export function variantForPlan(planId: string): string | undefined {
  switch (planId) {
    case "starter":
      return config.LEMONSQUEEZY_VARIANT_STARTER;
    case "business":
      return config.LEMONSQUEEZY_VARIANT_BUSINESS;
    case "pro":
      return config.LEMONSQUEEZY_VARIANT_PRO;
    default:
      return undefined;
  }
}

export interface LsCheckoutParams {
  planId: string;
  url: string;
  email: string;
}

/** Hosted-Checkout-Session bei Lemon Squeezy erzeugen; gibt die Checkout-URL zurück. */
export async function createLsCheckout(params: LsCheckoutParams): Promise<{ url: string }> {
  const variantId = variantForPlan(params.planId);
  if (!config.LEMONSQUEEZY_API_KEY || !config.LEMONSQUEEZY_STORE_ID) {
    throw new Error("Lemon Squeezy ist aktiviert, aber API-Key/Store-ID fehlen in der .env.");
  }
  if (!variantId) throw new Error(`Kein Lemon-Squeezy-Produkt (Variant-ID) für Tarif „${params.planId}".`);

  const payload = {
    data: {
      type: "checkouts",
      attributes: {
        checkout_data: {
          email: params.email,
          // custom-Werte kommen 1:1 im Webhook als meta.custom_data zurück.
          custom: { url: params.url, planId: params.planId, signup: "1", email: params.email },
        },
        product_options: { redirect_url: `${backendBase()}/willkommen.html` },
      },
      relationships: {
        store: { data: { type: "stores", id: String(config.LEMONSQUEEZY_STORE_ID) } },
        variant: { data: { type: "variants", id: String(variantId) } },
      },
    },
  };

  const res = await fetch(`${LS_API}/checkouts`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.api+json",
      "Content-Type": "application/vnd.api+json",
      Authorization: `Bearer ${config.LEMONSQUEEZY_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Lemon Squeezy Checkout-Fehler (${res.status}): ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: { attributes?: { url?: string } } };
  const url = json.data?.attributes?.url;
  if (!url) throw new Error("Lemon Squeezy: keine Checkout-URL erhalten.");
  return { url };
}

/** Webhook-Signatur prüfen (HMAC-SHA256 des Roh-Bodys mit dem Webhook-Secret). */
export function verifyLsSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!signature || !config.LEMONSQUEEZY_WEBHOOK_SECRET) return false;
  const digest = crypto
    .createHmac("sha256", config.LEMONSQUEEZY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const a = Buffer.from(digest, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

interface LsWebhookBody {
  meta?: { event_name?: string; custom_data?: Record<string, string> };
  data?: { id?: string; attributes?: { user_email?: string } };
}

/**
 * Webhook verarbeiten. Nur „subscription_created" löst die Provisionierung aus
 * (genau ein Event je neuem Abo -> keine Doppel-Anlage). Zusätzlich idempotent über
 * die Abo-ID, falls Lemon Squeezy einen Webhook erneut zustellt.
 */
export async function handleLsWebhook(
  rawBody: Buffer,
  signature: string | undefined,
): Promise<{ received: boolean }> {
  if (!verifyLsSignature(rawBody, signature)) {
    throw new Error("Ungültige Lemon-Squeezy-Signatur.");
  }
  const body = JSON.parse(rawBody.toString("utf8")) as LsWebhookBody;
  const event = body.meta?.event_name;
  if (event !== "subscription_created") return { received: true };

  const custom = body.meta?.custom_data || {};
  if (custom.signup !== "1" || !custom.url || !custom.planId) return { received: true };

  // Idempotenz: dieselbe Abo-ID nur einmal verarbeiten (Webhook-Retries).
  const subId = body.data?.id ? `lsub:${body.data.id}` : "";
  if (subId && getSetting(subId)) return { received: true };

  const plan = planById(custom.planId);
  if (!plan) return { received: true };
  const email = custom.email || body.data?.attributes?.user_email || "";
  const h = host(custom.url);

  const bot = createBot({
    tenantId: OPERATOR_TENANT_ID,
    name: h,
    startUrl: custom.url,
    maxPages: 50,
    allowedOrigins: h ? [h] : [],
  });
  applyPlanToBot(bot.id, plan.id, plan.setup.monthlyCents);
  if (subId) setSetting(subId, "1"); // Marker NACH erfolgreicher Anlage setzen

  if (email) {
    void provisionPaidBot(bot.id, email).catch((e) =>
      console.error("LS-Provisionierung fehlgeschlagen:", (e as Error).message),
    );
  }
  return { received: true };
}
