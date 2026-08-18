/**
 * Stripe-Webhook. Vollständig implementiert, aber INAKTIV solange STRIPE_ENABLED=false
 * oder kein Webhook-Secret gesetzt ist (dann 501). Aktivierung erfolgt AUSSCHLIESSLICH
 * über Umgebungsvariablen (STRIPE_ENABLED=true + STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)
 * und einen Neustart — kein Code-Eingriff nötig.
 *
 * Signaturprüfung braucht den UNVERÄNDERTEN Body -> in diesem (gekapselten) Plugin
 * wird application/json als Buffer geparst; andere Routen bleiben unberührt.
 */
import type { FastifyInstance } from "fastify";
import { stripeEnabled, handleWebhook } from "../payments/stripe.js";
import { config } from "../config.js";

export async function stripeRoutes(app: FastifyInstance): Promise<void> {
  // Raw-Body NUR für dieses Plugin (Encapsulation) — für die Stripe-Signatur.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/api/stripe/webhook", async (request, reply) => {
    if (!stripeEnabled() || !config.STRIPE_WEBHOOK_SECRET) {
      return reply.code(501).send({ error: "Stripe-Webhook noch nicht aktiviert." });
    }
    const sig = request.headers["stripe-signature"];
    if (!sig || Array.isArray(sig)) {
      return reply.code(400).send({ error: "Signatur fehlt." });
    }
    try {
      const result = handleWebhook(request.body as Buffer, sig);
      return reply.send(result);
    } catch (err) {
      request.log.error(err);
      // Ungültige Signatur / Verarbeitungsfehler -> 400, damit Stripe erneut zustellt.
      return reply.code(400).send({ error: `Webhook-Fehler: ${(err as Error).message}` });
    }
  });
}
