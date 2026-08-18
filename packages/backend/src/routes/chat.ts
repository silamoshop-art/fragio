/**
 * POST /api/chat/:botId — RAG-Chat mit SSE-Streaming.
 *
 * botId steht im Pfad (nicht im Body), damit CORS-Preflight (OPTIONS) und
 * Rate-Limiting den Bot schon vor dem Routing kennen.
 *
 * Sicherheit (Schritt 8):
 *   - Domain-Whitelist: Ist bots.allowed_origins gesetzt, muss der Origin-Header
 *     passen (serverseitig, zusätzlich zu CORS) — schützt vor Snippet-Diebstahl.
 *   - Rate-Limit pro botId (in server.ts konfiguriert).
 *
 * Body: { message: string }
 * Response: text/event-stream mit Events meta | token | done | error.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBot, consumeQuota } from "../db/repo.js";
import { answerQuestion } from "../rag/answer.js";
import { isOriginAllowed, parseAllowedOrigins } from "../util/origin.js";
import { sha256 } from "../util/id.js";
import { config } from "../config.js";

/** IP nur gehasht (SHA-256 mit server-geheimem Salt) — keine Klartext-IP in der DB. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return sha256(config.secretKey.toString("hex") + "|sitebot-ip|" + ip);
}

// Absolute Obergrenze (Missbrauchsschutz); das pro-Bot-Limit greift zusätzlich darunter.
const HARD_INPUT_CEILING = 4000;
const BodySchema = z.object({
  message: z.string().min(1).max(HARD_INPUT_CEILING),
  // Analytics-Einwilligung: true = Gesprächsverlauf für Statistiken speichern.
  // Fehlt/false = "Nur notwendige Verarbeitung" (kein chat_logs-Inhalt).
  storeContent: z.boolean().optional(),
});

const DEFAULT_LIMIT_MESSAGE =
  "Das monatliche Anfrage-Limit dieses Chatbots wurde erreicht. " +
  "Bitte kontaktiere das Unternehmen direkt.";

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { botId: string } }>(
    "/api/chat/:botId",
    {
      config: {
        // Rate-Limit-Marker: keyGenerator in server.ts nutzt diesen Pfad-Param.
        rateLimit: {},
      },
    },
    async (request, reply) => {
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "message fehlt oder ist zu lang." });
      }
      const bot = getBot(request.params.botId);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      if (bot.status !== "active") {
        return reply.code(403).send({ error: `Bot ist ${bot.status}.` });
      }

      // Domain-Whitelist serverseitig durchsetzen.
      const allowed = parseAllowedOrigins(bot.allowed_origins);
      const origin = request.headers.origin;
      if (!isOriginAllowed(origin, allowed)) {
        return reply
          .code(403)
          .send({ error: "Origin nicht erlaubt für diesen Bot." });
      }

      // Pro-Bot-Zeichenlimit (zusätzlich zur absoluten Obergrenze).
      if (parsed.data.message.length > bot.max_input_chars) {
        return reply
          .code(413)
          .send({ error: `Nachricht zu lang (max. ${bot.max_input_chars} Zeichen).` });
      }

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // Monatliches Kontingent atomar prüfen + verbrauchen (Schritt 5).
      const quota = consumeQuota(bot.id);
      if (!quota.allowed) {
        const limitMsg = bot.limit_message || DEFAULT_LIMIT_MESSAGE;
        send("meta", { answered: false, limited: true, sources: [], usage: quota });
        send("token", { t: limitMsg });
        send("done", {});
        res.end();
        return;
      }

      try {
        // Nur mit Analytics-Einwilligung wird der Gesprächsinhalt in chat_logs
        // gespeichert; Kontingent (oben) + Rate-Limit laufen unabhängig davon.
        const stream = answerQuestion(
          bot,
          parsed.data.message,
          (meta) => send("meta", { ...meta, usage: quota }),
          { storeContent: parsed.data.storeContent === true, ipHash: hashIp(request.ip) },
        );
        for await (const piece of stream) send("token", { t: piece });
        send("done", {});
      } catch (err) {
        request.log.error(err);
        send("error", { message: "Bei der Antwortgenerierung ist ein Fehler aufgetreten." });
      } finally {
        res.end();
      }
    },
  );
}
