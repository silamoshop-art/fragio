/**
 * Öffentlicher Self-Service-Kauf.
 *
 *  - GET  /api/signup/plans   Tarife (Preis/Kontingent) für die Auswahl.
 *  - POST /api/signup         { email, url, planId } -> Stripe-Checkout-URL.
 *
 * Es wird bewusst NOCH KEIN Bot/Account angelegt: das geschieht erst nach
 * bestätigter Zahlung im Stripe-Webhook (payments/stripe.ts -> provisionPaidBot).
 * So bleiben keine unbezahlten Karteileichen zurück, und niemand kann ohne Zahlung
 * einen Crawl auslösen.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { checkPublicHttpUrl } from "../util/url-guard.js";
import { getPlanDefs, planById } from "../billing/plans.js";
import { stripeEnabled, createCheckoutSession } from "../payments/stripe.js";
import { lsEnabled, createLsCheckout } from "../payments/lemonsqueezy.js";
import { createOrder } from "../onboarding/order.js";
import { operatorConfig } from "../config/operator.js";
import { backendBase } from "../util/embed.js";

/** Ist ein Online-Zahlungsanbieter scharfgeschaltet? (sonst: Rechnung/Überweisung) */
function onlinePaymentReady(): boolean {
  return lsEnabled() || stripeEnabled();
}

const SignupSchema = z.object({
  email: z.string().email().max(200),
  url: z.string().min(3).max(2048),
  planId: z.enum(["starter", "business", "pro"]),
  // Für die Rechnung (Banküberweisung) nötig; bei Online-Zahlung optional.
  name: z.string().max(200).optional(),
  address: z.string().max(500).optional(),
  vat: z.string().max(80).optional(),
});

function normalizeUrl(raw: string): string {
  const t = raw.trim();
  return /^https?:\/\//i.test(t) ? t : "https://" + t.replace(/^\/+/, "");
}

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  // Öffentliche Tarifliste (Self-Service-Variante „setup": Monatspreis + einmalige Gebühr).
  app.get("/api/signup/plans", async () => {
    const currency = operatorConfig().currency || "EUR";
    return {
      currency,
      // "online" = Karten-Checkout (LS/Stripe); "invoice" = Rechnung/Überweisung+PayPal.
      mode: onlinePaymentReady() ? "online" : "invoice",
      // Self-Service = reines Monatsabo ohne Einrichtungsgebühr (setupCents: 0).
      plans: getPlanDefs().map((p) => ({
        id: p.id,
        name: p.name,
        limit: p.limit,
        monthlyCents: p.setup.monthlyCents,
        setupCents: 0,
      })),
    };
  });

  app.post("/api/signup", async (request, reply) => {
    const parsed = SignupSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bitte E-Mail, Website-Adresse und Tarif angeben." });
    }

    // Eingaben ZUERST validieren (auch SSRF), unabhängig vom Zahlungsstatus.
    const url = normalizeUrl(parsed.data.url);
    const check = checkPublicHttpUrl(url);
    if (!check.ok) return reply.code(400).send({ error: check.reason || "Adresse nicht erlaubt." });

    const plan = planById(parsed.data.planId);
    if (!plan) return reply.code(400).send({ error: "Unbekannter Tarif." });

    const cleanUrl = check.normalized || url;
    const base = backendBase();

    // 1) Online-Zahlung aktiv -> Hosted-Checkout (Lemon Squeezy bevorzugt, sonst Stripe).
    if (onlinePaymentReady()) {
      try {
        if (lsEnabled()) {
          const { url: checkoutUrl } = await createLsCheckout({
            planId: plan.id,
            url: cleanUrl,
            email: parsed.data.email,
          });
          return { mode: "online", url: checkoutUrl };
        }
        const { url: checkoutUrl } = await createCheckoutSession({
          planId: plan.id,
          variant: "setup",
          monthlyCents: plan.setup.monthlyCents,
          setupCents: 0,
          url: cleanUrl,
          email: parsed.data.email,
          signup: true,
          successUrl: `${base}/willkommen.html`,
          cancelUrl: `${base}/signup.html?abbruch=1&plan=${plan.id}`,
        });
        return { mode: "online", url: checkoutUrl };
      } catch (err) {
        request.log.error(err);
        return reply.code(502).send({ error: "Checkout konnte nicht gestartet werden. Bitte später erneut versuchen." });
      }
    }

    // 2) Sonst: Kauf per Rechnung (Banküberweisung). Name + Adresse Pflicht.
    const name = (parsed.data.name || "").trim();
    const address = (parsed.data.address || "").trim();
    if (name.length < 2 || address.length < 5) {
      return reply.code(400).send({ error: "Für die Rechnung bitte Name und Anschrift angeben." });
    }
    try {
      const order = await createOrder({
        email: parsed.data.email,
        name,
        address,
        vat: parsed.data.vat || null,
        url: cleanUrl,
        planId: plan.id,
      });
      return { mode: "invoice", order };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: "Bestellung konnte nicht angelegt werden. Bitte später erneut versuchen." });
    }
  });
}
