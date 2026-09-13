/**
 * Lemon Squeezy Webhook. Inaktiv, solange LEMONSQUEEZY_ENABLED (+ Keys/Secret) fehlt
 * (dann 501). Die Signaturprüfung braucht den UNVERÄNDERTEN Body -> in diesem
 * gekapselten Plugin wird application/json als Buffer geparst; andere Routen bleiben
 * unberührt.
 */
import type { FastifyInstance } from "fastify";
import { lsEnabled, handleLsWebhook } from "../payments/lemonsqueezy.js";

export async function lemonSqueezyRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/api/lemonsqueezy/webhook", async (request, reply) => {
    if (!lsEnabled()) {
      return reply.code(501).send({ error: "Lemon-Squeezy-Webhook noch nicht aktiviert." });
    }
    const sig = request.headers["x-signature"];
    if (!sig || Array.isArray(sig)) {
      return reply.code(400).send({ error: "Signatur fehlt." });
    }
    try {
      const result = await handleLsWebhook(request.body as Buffer, sig);
      return reply.send(result);
    } catch (err) {
      request.log.error(err);
      // Ungültige Signatur / Fehler -> 400, damit Lemon Squeezy erneut zustellt.
      return reply.code(400).send({ error: `Webhook-Fehler: ${(err as Error).message}` });
    }
  });
}
