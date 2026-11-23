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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  getBot,
  consumeQuota,
  markEmbeddedSeen,
  insertFeedback,
  createLead,
  shouldWarnQuota,
  type BotRow,
} from "../db/repo.js";
import { answerQuestion } from "../rag/answer.js";
import { isOriginAllowed, parseAllowedOrigins, isFragioOrigin } from "../util/origin.js";
import { sha256 } from "../util/id.js";
import { config } from "../config.js";
import { checkVisitor, looksLikeBot } from "../util/throttle.js";
import { sendEmail, sendOperatorEmail } from "../notify/email.js";

/** IP nur gehasht (SHA-256 mit server-geheimem Salt) — keine Klartext-IP in der DB. */
function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return sha256(config.secretKey.toString("hex") + "|sitebot-ip|" + ip);
}

// Review 2026-11-22 (F-001/F-008/P-001): UA-unabhängiger Tages-Hardcap pro Bot.
// Greift zusätzlich zum Monats-Kontingent und auch dann, wenn der User-Agent als
// Bot erkannt wird (Bot-Traffic würde das Monats-Kontingent sonst NICHT belasten
// → Kostenkanal offen). In-Memory-Map; Single-Process-Setup wie util/throttle.ts.
// Bei Prozess-Restart wird der Zähler zurückgesetzt — bewusster Trade-off.
const BOT_DAILY_HARD_CAP = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;
const botDailyHits = new Map<string, { windowStart: number; count: number }>();
function consumeBotDailyCap(botId: string, now = Date.now()): boolean {
  const cur = botDailyHits.get(botId);
  if (!cur || now - cur.windowStart >= DAY_MS) {
    botDailyHits.set(botId, { windowStart: now, count: 1 });
    return true;
  }
  if (cur.count >= BOT_DAILY_HARD_CAP) return false;
  cur.count++;
  return true;
}

// Absolute Obergrenze (Missbrauchsschutz); das pro-Bot-Limit greift zusätzlich darunter.
const HARD_INPUT_CEILING = 4000;
const BodySchema = z.object({
  message: z.string().min(1).max(HARD_INPUT_CEILING),
  // Analytics-Einwilligung: true = Gesprächsverlauf für Statistiken speichern.
  // Fehlt/false = "Nur notwendige Verarbeitung" (kein chat_logs-Inhalt).
  storeContent: z.boolean().optional(),
  // Bisheriger Gesprächsverlauf (Prompt 15 #3), OHNE die aktuelle Nachricht.
  // Nur zum Verständnis kurzer Folgefragen; wird nicht dauerhaft gespeichert.
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(8)
    .optional(),
});

const DEFAULT_LIMIT_MESSAGE =
  "Das monatliche Anfrage-Limit dieses Chatbots wurde erreicht. " +
  "Bitte kontaktiere das Unternehmen direkt.";

const THROTTLE_MESSAGE =
  "Du hast in kurzer Zeit sehr viele Fragen gestellt. Bitte versuche es später " +
  "noch einmal — oder kontaktiere das Unternehmen direkt.";

/** Ziel für Lead-/Kontingent-Benachrichtigungen: der Kunde (Bot-Inhaber), sonst der Betreiber. */
function notifyOwner(bot: BotRow, subject: string, body: string): void {
  const to = bot.customer_email;
  if (to) {
    void sendEmail(to, subject, body).catch(() => {});
  } else {
    void sendOperatorEmail(subject, body).catch(() => {});
  }
}

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
      // Review 2026-11-22 (F-001/F-009/P-001): Chat nur aktiv, wenn LIVE_DEMO_ENABLED=true.
      // Vorher war nur /api/widget/site durch den Schalter gegated → der Chat-Endpunkt
      // konnte direkt angesprochen werden und Anthropic-Kosten auslösen, obwohl die
      // Datenschutzseite „Live-Demo deaktiviert" sagte.
      if (!config.liveDemoEnabled) {
        return reply.code(503).send({ error: "Live-Chat ist derzeit deaktiviert." });
      }
      const parsed = BodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "message fehlt oder ist zu lang." });
      }
      const bot = getBot(request.params.botId);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      if (bot.status !== "active") {
        return reply.code(403).send({ error: `Bot ist ${bot.status}.` });
      }

      // Harte Sperre (Info-Website): Chat nur von fragio.at — fremde Einbettungen
      // bzw. fremde data-bot-id werden serverseitig abgelehnt.
      const origin = request.headers.origin;
      if (!isFragioOrigin(origin)) {
        return reply.code(403).send({ error: "Fragio wird nur auf fragio.at bereitgestellt." });
      }
      // Domain-Whitelist serverseitig durchsetzen.
      const allowed = parseAllowedOrigins(bot.allowed_origins);
      if (!isOriginAllowed(origin, allowed)) {
        return reply
          .code(403)
          .send({ error: "Origin nicht erlaubt für diesen Bot." });
      }

      // Echte Einbindung erkennen (nur wenn eine Domain hinterlegt IST und der
      // Origin dazu passt): so zählt Test-/Vorschau-Traffic (Backend-Origin,
      // localhost) NICHT als "eingebunden". Bei leerer Whitelist würde jeder
      // Origin "passen" — deshalb hier ausdrücklich allowed.length > 0 fordern.
      if (allowed.length > 0 && origin) {
        markEmbeddedSeen(bot.id);
      }

      // Pro-Bot-Zeichenlimit (zusätzlich zur absoluten Obergrenze).
      if (parsed.data.message.length > bot.max_input_chars) {
        return reply
          .code(413)
          .send({ error: `Nachricht zu lang (max. ${bot.max_input_chars} Zeichen).` });
      }

      // Review 2026-11-22 (F-008/P-001): UA-unabhängiges Tages-Hardcap pro Bot.
      // Greift VOR dem LLM-Call und auch dann, wenn looksLikeBot() matcht
      // (das würde sonst das Monatskontingent umgehen).
      if (!consumeBotDailyCap(bot.id)) {
        return reply.code(429).send({ error: "Tages-Limit für diesen Bot erreicht." });
      }

      const ipHash = hashIp(request.ip);
      const isBot = looksLikeBot(request.headers["user-agent"] as string | undefined);

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

      // Pro-Besucher-Drosselung (Anforderung C): begrenzt EINEN Browser/IP-Hash auf
      // eine plausible Nutzung. Gedrosselte Anfragen zählen NICHT gegen das Kontingent.
      const visitorKey = `${bot.id}:${ipHash || request.ip}`;
      const throttle = checkVisitor(visitorKey);
      if (!throttle.allowed) {
        send("meta", { answered: false, throttled: true, sources: [] });
        send("token", { t: THROTTLE_MESSAGE });
        send("done", {});
        res.end();
        return;
      }

      // Monatliches Kontingent atomar prüfen + verbrauchen (Schritt 5). Erkannter
      // Bot-/Crawler-Traffic wird beantwortet, belastet aber das Kontingent NICHT
      // (Anforderung C: „Bots/Crawler zählen nicht gegen mein Kontingent").
      const quota = isBot
        ? { allowed: true, used: 0, quota: bot.monthly_quota }
        : consumeQuota(bot.id);
      if (!quota.allowed) {
        const limitMsg = bot.limit_message || DEFAULT_LIMIT_MESSAGE;
        send("meta", { answered: false, limited: true, sources: [], usage: quota });
        send("token", { t: limitMsg });
        send("done", {});
        res.end();
        // Kein automatisches Abschalten, keine Nachverrechnung (Anforderung C):
        // stattdessen den Inhaber informieren, damit er sich melden kann.
        notifyOwner(
          bot,
          `Kontingent erreicht: ${bot.name}`,
          `Der Chatbot „${bot.name}" (${bot.id}) hat das Monats-Kontingent von ` +
            `${quota.quota} Antworten erreicht. Es wird nichts automatisch abgeschaltet und ` +
            `nichts nachverrechnet. Bei Bedarf das Kontingent gemeinsam anheben.`,
        );
        return;
      }
      // 80%-Frühwarnung (Anforderung C) — pro Monat höchstens einmal.
      if (!isBot && shouldWarnQuota(bot)) {
        notifyOwner(
          bot,
          `80% des Kontingents erreicht: ${bot.name}`,
          `Der Chatbot „${bot.name}" (${bot.id}) hat 80% des Monats-Kontingents ` +
            `(${quota.quota} Antworten) genutzt. Nur zur Info — es wird nichts abgeschaltet.`,
        );
      }

      // Review 2026-11-22 (F-026/NEU-1/P-001+P-002): Stream bei Client-Disconnect
      // abbrechen. Vorher lief der Anthropic-Stream serverseitig weiter, obwohl
      // der Browser schon weg war — reine Kostenverschwendung.
      const abort = new AbortController();
      request.raw.on("close", () => {
        // reply.raw.writableEnded = Antwort regulär beendet; nur bei echtem
        // Client-Disconnect (vor „done") den LLM-Stream abbrechen.
        if (!res.writableEnded) abort.abort();
      });
      try {
        // Nur mit Analytics-Einwilligung wird der Gesprächsinhalt in chat_logs
        // gespeichert; Kontingent (oben) + Rate-Limit laufen unabhängig davon.
        // Pro Antwort eine ID: das Widget hängt daran die spätere Bewertung (Daumen).
        const msgId = randomUUID();
        const stream = answerQuestion(
          bot,
          parsed.data.message,
          (meta) => send("meta", { ...meta, usage: quota, msgId }),
          {
            storeContent: parsed.data.storeContent === true,
            ipHash,
            history: parsed.data.history,
            msgId,
            signal: abort.signal,
          },
        );
        for await (const piece of stream) {
          if (abort.signal.aborted) break;
          send("token", { t: piece });
        }
        send("done", {});
      } catch (err) {
        request.log.error(err);
        send("error", { message: "Bei der Antwortgenerierung ist ein Fehler aufgetreten." });
      } finally {
        res.end();
      }
    },
  );

  // Antwort-Bewertung (Daumen hoch/runter). Speichert bewusst KEINEN Inhalt und
  // KEINE IP — nur Bot, Antwort-ID (msgId) und die Wertung. Idempotent je Antwort.
  const FeedbackSchema = z.object({
    msgId: z.string().min(8).max(64),
    rating: z.enum(["up", "down"]),
  });
  app.post<{ Params: { botId: string } }>(
    "/api/chat/:botId/feedback",
    { config: { rateLimit: {} } },
    async (request, reply) => {
      // Review 2026-11-22 (F-036/P-001): gleiche Gates wie beim Chat — ohne
      // Origin-Prüfung konnten beliebige Clients Statistiken verfälschen.
      if (!config.liveDemoEnabled) return reply.code(503).send({ error: "deaktiviert." });
      if (!isFragioOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: "Nur auf fragio.at verfügbar." });
      }
      const bot = getBot(request.params.botId);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const parsed = FeedbackSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Bewertung." });
      insertFeedback(bot.id, parsed.data.msgId, parsed.data.rating);
      return { ok: true };
    },
  );

  // --- Lead-Erfassung (Anforderung A) ---
  // Kommt der Bot nicht weiter, kann der Besucher Kontaktdaten hinterlassen. Wird
  // gespeichert (Portal/Dashboard) und dem Inhaber per E-Mail gemeldet. Origin-
  // Whitelist + Rate-Limit gelten wie beim Chat (Kostenschutz/Snippet-Schutz).
  const LeadSchema = z.object({
    name: z.string().max(120).optional(),
    email: z.string().email().max(200).optional().or(z.literal("")),
    phone: z.string().max(60).optional(),
    message: z.string().max(2000).optional(),
    contextQuestion: z.string().max(2000).optional(),
  });
  app.post<{ Params: { botId: string } }>(
    "/api/chat/:botId/lead",
    { config: { rateLimit: {} } },
    async (request, reply) => {
      // Review 2026-11-22 (F-028/NEU-4/P-001): gleiche Gates wie beim Chat.
      // Vorher fehlte die isFragioOrigin-Prüfung — bei Bot mit leerer
      // allowed_origins hätte jeder Lead-Spam an den Betreiber senden können.
      if (!config.liveDemoEnabled) return reply.code(503).send({ error: "deaktiviert." });
      if (!isFragioOrigin(request.headers.origin)) {
        return reply.code(403).send({ error: "Nur auf fragio.at verfügbar." });
      }
      const bot = getBot(request.params.botId);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      if (!bot.lead_capture) {
        return reply.code(403).send({ error: "Lead-Erfassung ist für diesen Bot nicht aktiv." });
      }
      // Serverseitige Origin-Whitelist (wie beim Chat).
      if (!isOriginAllowed(request.headers.origin, parseAllowedOrigins(bot.allowed_origins))) {
        return reply.code(403).send({ error: "Origin nicht erlaubt für diesen Bot." });
      }
      const parsed = LeadSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Eingabe." });
      const d = parsed.data;
      const email = (d.email || "").trim();
      const phone = (d.phone || "").trim();
      // Mindestens eine Kontaktmöglichkeit muss vorhanden sein.
      if (!email && !phone) {
        return reply.code(400).send({ error: "Bitte E-Mail oder Telefonnummer angeben." });
      }
      const lead = createLead({
        botId: bot.id,
        name: (d.name || "").trim() || null,
        email: email || null,
        phone: phone || null,
        message: (d.message || "").trim() || null,
        contextQ: (d.contextQuestion || "").trim() || null,
      });
      notifyOwner(
        bot,
        `Neue Kontaktanfrage über den Chatbot: ${bot.name}`,
        [
          `Über den Chatbot „${bot.name}" ist eine neue Kontaktanfrage eingegangen:`,
          ``,
          `Name:     ${lead.name || "—"}`,
          `E-Mail:   ${lead.email || "—"}`,
          `Telefon:  ${lead.phone || "—"}`,
          `Anliegen: ${lead.message || "—"}`,
          lead.context_q ? `\nAusgelöst durch die Frage: „${lead.context_q}"` : "",
          ``,
          `Alle Anfragen siehst du auch in deinem Portal.`,
        ].join("\n"),
      );
      return { ok: true };
    },
  );
}
