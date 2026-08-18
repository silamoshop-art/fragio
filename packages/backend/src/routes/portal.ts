/**
 * Kunden-Portal-API — komplett getrennt vom Admin/Tenant-Bereich.
 *
 * SICHERHEIT / ISOLATION:
 * - Login mit E-Mail + Passwort (bot_users). Erfolgreicher Login -> signierter
 *   Session-Token, der an GENAU EINEN bot gebunden ist (portal/token.ts).
 * - Der preHandler verifiziert den Token und setzt request.portalBotId. ALLE
 *   Endpoints nutzen ausschließlich diese botId aus dem Token — niemals eine
 *   botId aus Query/Body/Params. Ein Kunde kann so keinen fremden Bot sehen.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getBotUserByEmail,
  getBotUserById,
  getBot,
  getBotUsage,
  getPortalAnalytics,
  type BotRow,
} from "../db/repo.js";
import { verifyPassword } from "../crypto/password.js";
import { signPortalToken, verifyPortalToken } from "../portal/token.js";
import { snippetFor, backendBase } from "../util/embed.js";
import { updateBot, listChatLogs, deleteChatLogsByIpHash } from "../db/repo.js";
import {
  listManualFaqs,
  createManualFaq,
  updateManualFaq,
  deleteManualFaq,
} from "../db/repo.js";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getPlanDefs, planById, planName, planVariant, getAddons } from "../billing/plans.js";
import { createPlanChangeRequest, listOpenRequestKinds } from "../db/repo.js";
import { sendOperatorEmail, sendEmail } from "../notify/email.js";
import { stripeEnabled, createCheckoutSession } from "../payments/stripe.js";
import { operatorConfig } from "../config/operator.js";

declare module "fastify" {
  interface FastifyRequest {
    portalBotId?: string;
  }
}

// Verbrauch + Status (Farblogik wie im Design): grün / gelb ab 80% / rot bei 100%.
function usageView(bot: BotRow) {
  const { used, quota } = getBotUsage(bot);
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  let status: "ok" | "warn" | "full" = "ok";
  if (pct >= 100) status = "full";
  else if (pct >= 80) status = "warn";
  return { used, quota, pct, status };
}

function currentPlanId(bot: BotRow): string | null {
  if (bot.plan && planById(bot.plan)) return bot.plan;
  return null;
}

export async function portalRoutes(app: FastifyInstance): Promise<void> {
  // --- Login (ohne Auth) ---
  app.post("/api/portal/login", async (request, reply) => {
    const parsed = z
      .object({ email: z.string().email(), password: z.string().min(1).max(200) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "E-Mail und Passwort nötig." });

    const user = getBotUserByEmail(parsed.data.email.toLowerCase().trim());
    // Zeitkonstante-ähnliche Antwort: gleiche Fehlermeldung, egal ob User existiert.
    if (!user || !verifyPassword(parsed.data.password, user.password_hash)) {
      return reply.code(401).send({ error: "E-Mail oder Passwort falsch." });
    }
    const bot = getBot(user.bot_id);
    if (!bot) return reply.code(403).send({ error: "Bot nicht verfügbar." });

    const token = signPortalToken(user.id, user.bot_id);
    return { token, botName: bot.name };
  });

  // --- Alles Weitere: Session-Token erforderlich, botId AUS dem Token ---
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
    if (!m) return reply.code(401).send({ error: "Nicht angemeldet." });
    const claims = verifyPortalToken(m[1].trim());
    if (!claims) return reply.code(401).send({ error: "Sitzung ungültig oder abgelaufen." });
    // Zusatz-Absicherung: bot_user muss noch existieren und zum selben Bot gehören.
    const user = getBotUserById(claims.bu);
    if (!user || user.bot_id !== claims.bot) {
      return reply.code(401).send({ error: "Sitzung ungültig." });
    }
    request.portalBotId = claims.bot; // <- einzige Quelle der botId
  };

  app.register(async (secured) => {
    secured.addHook("preHandler", authenticate);

    const loadBot = (request: FastifyRequest): BotRow | undefined => getBot(request.portalBotId!);

    secured.get("/api/portal/overview", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      return {
        botName: bot.name,
        planId: currentPlanId(bot),
        planName: currentPlanId(bot) ? planName(bot.plan) : null,
        priceCents: bot.price_cents,
        usage: usageView(bot),
        widgetActive: !!bot.last_crawled_at, // grober Indikator
      };
    });

    secured.get("/api/portal/plans", async () => ({
      plans: getPlanDefs().map((p) => ({
        id: p.id,
        name: p.name,
        limit: p.limit,
        setup: { monthlyCents: p.setup.monthlyCents, setupCents: p.setup.setupCents },
        commit: { monthlyCents: p.commit.monthlyCents, commitmentMonths: p.commit.commitmentMonths },
      })),
    }));

    // Tarif/Variante ANFRAGEN — ändert NICHTS am Bot.
    // Stripe aus: Anfrage speichern + Operator per E-Mail benachrichtigen.
    // Stripe an: Checkout-Session starten (Freischaltung dann per Webhook).
    secured.post("/api/portal/plan-request", async (request, reply) => {
      const parsed = z
        .object({
          planId: z.enum(["starter", "business", "pro"]),
          variant: z.enum(["setup", "commit"]),
        })
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Auswahl." });
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const { planId, variant } = parsed.data;
      const v = planVariant(planId, variant)!;

      if (stripeEnabled()) {
        try {
          const { url } = await createCheckoutSession({
            botId: bot.id,
            planId,
            variant,
            monthlyCents: v.monthlyCents,
            setupCents: v.setupCents,
          });
          return { mode: "checkout" as const, url };
        } catch (err) {
          request.log.error(err);
          return reply.code(503).send({ error: "Zahlung derzeit nicht möglich. Bitte später erneut." });
        }
      }

      // Manueller Ablauf: Anfrage speichern + Operator benachrichtigen.
      createPlanChangeRequest({
        botId: bot.id,
        planId,
        variant,
        monthlyCents: v.monthlyCents,
        setupCents: v.setupCents,
        commitmentMonths: v.commitmentMonths,
      });
      const variantText =
        variant === "setup"
          ? `${(v.monthlyCents / 100).toFixed(0)} €/Monat + ${(v.setupCents / 100).toFixed(0)} € Einrichtung (monatlich kündbar)`
          : `${(v.monthlyCents / 100).toFixed(0)} €/Monat, ${v.commitmentMonths} Monate Bindung`;
      await sendOperatorEmail(
        `Neue Tarif-Anfrage: ${bot.name} → ${planName(planId)}`,
        `Bot: ${bot.name} (${bot.id})\nTarif: ${planName(planId)}\nVariante: ${variantText}\n\n` +
          `Nächste Schritte: Rechnung verschicken, nach Zahlungseingang im Dashboard freischalten.`,
      );

      return {
        mode: "request" as const,
        message: "Anfrage gesendet — du bekommst in Kürze eine Rechnung per E-Mail.",
      };
    });

    // Branding-Zusatzoptionen: Status + Preise (aus konfigurierbaren Preisen).
    secured.get("/api/portal/addons", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const a = getAddons();
      const open = listOpenRequestKinds(bot.id);
      const st = (active: boolean, kinds: string[]): "active" | "pending" | "available" =>
        active ? "active" : kinds.some((k) => open.includes(k)) ? "pending" : "available";
      return {
        logo: { priceCents: a.logoCents, status: st(!!bot.addon_logo, ["addon_logo", "addon_bundle"]) },
        name: { priceCents: a.nameCents, status: st(!!bot.addon_name, ["addon_name", "addon_bundle"]) },
        bundle: {
          priceCents: a.bundleCents,
          status: st(!!bot.addon_logo && !!bot.addon_name, ["addon_bundle"]),
        },
      };
    });

    secured.post("/api/portal/addon-request", async (request, reply) => {
      const parsed = z.object({ addon: z.enum(["logo", "name", "bundle"]) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Option." });
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const a = getAddons();
      const map = {
        logo: { kind: "addon_logo", cents: a.logoCents, label: "Eigenes Logo" },
        name: { kind: "addon_name", cents: a.nameCents, label: "Eigener Bot-Name" },
        bundle: { kind: "addon_bundle", cents: a.bundleCents, label: "Logo + Name (Bundle)" },
      }[parsed.data.addon];

      createPlanChangeRequest({
        botId: bot.id,
        planId: parsed.data.addon,
        variant: "-",
        monthlyCents: map.cents,
        setupCents: 0,
        commitmentMonths: 0,
        kind: map.kind,
      });
      await sendOperatorEmail(
        `Zusatzoption angefragt: ${bot.name} → ${map.label}`,
        `Bot: ${bot.name} (${bot.id})\nOption: ${map.label} (+${(map.cents / 100).toFixed(0)} €/Monat)\n\n` +
          `Nach Zahlungseingang im Dashboard freischalten.`,
      );
      return {
        mode: "request" as const,
        message: "Anfrage gesendet — du bekommst in Kürze eine Rechnung per E-Mail.",
      };
    });

    secured.get("/api/portal/analytics", async (request, reply) => {
      const botId = request.portalBotId!;
      if (!getBot(botId)) return reply.code(404).send({ error: "Bot nicht gefunden." });
      return getPortalAnalytics(botId, 30);
    });

    // Support-Kontakt: reine Weiterleitung per E-Mail an die Support-Adresse aus
    // operator.config.json, inkl. Zuordnung zu Bot/Firma. Keine Ticket-Historie.
    secured.post("/api/portal/support", async (request, reply) => {
      const parsed = z
        .object({
          message: z.string().min(3).max(4000),
          replyEmail: z.string().email().or(z.literal("")).optional(),
        })
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Bitte eine Nachricht eingeben." });
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const supportTo = operatorConfig().supportEmail;
      await sendEmail(
        supportTo,
        `Support-Anfrage: ${bot.name}`,
        `Bot/Firma: ${bot.name} (${bot.id})\n` +
          `Antwort an: ${parsed.data.replyEmail || "— (keine angegeben)"}\n\n` +
          parsed.data.message,
      );
      return { ok: true, message: "Danke! Deine Nachricht wurde an unser Support-Team gesendet." };
    });

    // --- Manuelle FAQs (Prompt 14 #5): der Kunde pflegt eigene Antworten ---
    const portalFaqSchema = z.object({
      question: z.string().min(2).max(500),
      answer: z.string().min(1).max(4000),
    });

    secured.get("/api/portal/faqs", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      return listManualFaqs(bot.id);
    });

    secured.post("/api/portal/faqs", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const parsed = portalFaqSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Frage (min. 2) und Antwort nötig." });
      return createManualFaq(bot.id, parsed.data.question.trim(), parsed.data.answer.trim());
    });

    secured.patch("/api/portal/faqs/:faqId", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const parsed = portalFaqSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Frage (min. 2) und Antwort nötig." });
      const faqId = Number((request.params as { faqId: string }).faqId);
      const ok = updateManualFaq(bot.id, faqId, parsed.data.question.trim(), parsed.data.answer.trim());
      if (!ok) return reply.code(404).send({ error: "FAQ nicht gefunden." });
      return { ok: true };
    });

    secured.delete("/api/portal/faqs/:faqId", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const faqId = Number((request.params as { faqId: string }).faqId);
      const ok = deleteManualFaq(bot.id, faqId);
      if (!ok) return reply.code(404).send({ error: "FAQ nicht gefunden." });
      return { ok: true };
    });

    secured.get("/api/portal/snippet", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      return { snippet: snippetFor(bot.id), widgetActive: !!bot.last_crawled_at };
    });

    // Chat-Log-Detailansicht für den Kunden (nur eigener Bot, botId aus Token).
    secured.get("/api/portal/chat-logs", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      return listChatLogs(bot.id, 100).map((l) => ({
        id: l.id,
        question: l.question,
        answered: !!l.answered,
        ipHash: l.ip_hash,
        createdAt: l.created_at,
      }));
    });

    // Löschanspruch: alle Anfragen desselben Absenders (IP-Hash) löschen (Art. 17 DSGVO).
    secured.post("/api/portal/chat-logs/delete-by-sender", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      const parsed = z.object({ ipHash: z.string().min(16).max(128) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "ipHash fehlt." });
      const deleted = deleteChatLogsByIpHash(bot.id, parsed.data.ipHash);
      return { deleted };
    });

    // Logo-Upload (Prompt 9 #3): echter Datei-Upload statt URL-Feld.
    // Nur nach Freischaltung des Logo-Add-ons. Sicherheit: nur echte Bilddateien
    // (PNG/JPG/SVG, per Magic-Bytes geprüft), max. 2 MB (server-seitiges Limit),
    // SVG mit Skript-/Event-Handler-Inhalt wird abgelehnt; Auslieferung mit
    // CSP+nosniff+sandbox (siehe server.ts), Anzeige nur via <img>.
    secured.post("/api/portal/logo", async (request, reply) => {
      const bot = loadBot(request);
      if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
      if (!bot.addon_logo) {
        return reply.code(403).send({ error: "Logo-Option ist für diesen Bot nicht freigeschaltet." });
      }
      const mp = await request.file();
      if (!mp) return reply.code(400).send({ error: "Keine Datei empfangen." });

      let buf: Buffer;
      try {
        buf = await mp.toBuffer(); // wirft, wenn > 2 MB (Limit aus server.ts)
      } catch {
        return reply.code(413).send({ error: "Datei zu groß (max. 2 MB)." });
      }
      if (mp.file.truncated) return reply.code(413).send({ error: "Datei zu groß (max. 2 MB)." });

      const kind = detectImage(buf);
      if (!kind) {
        return reply.code(415).send({ error: "Nur echte Bilddateien erlaubt: PNG, JPG oder SVG." });
      }

      // Alte Logo-Dateien dieses Bots entfernen (jede Endung), dann neu schreiben.
      const logosDir = path.join(path.dirname(config.DATABASE_PATH), "logos");
      fs.mkdirSync(logosDir, { recursive: true });
      for (const ext of ["png", "jpg", "svg"]) {
        const p = path.join(logosDir, `${bot.id}.${ext}`);
        if (fs.existsSync(p)) fs.unlinkSync(p);
      }
      fs.writeFileSync(path.join(logosDir, `${bot.id}.${kind.ext}`), buf);

      const logoUrl = `${backendBase()}/logos/${bot.id}.${kind.ext}?v=${Date.now()}`;
      let branding: Record<string, unknown> = {};
      try {
        branding = JSON.parse(bot.branding);
      } catch {
        branding = {};
      }
      branding.logoUrl = logoUrl;
      updateBot(bot.id, { branding: JSON.stringify(branding) });
      return { ok: true, logoUrl };
    });
  });
}

/** Erkennt PNG/JPG/SVG anhand der Magic-Bytes; lehnt SVG mit aktivem Inhalt ab. */
function detectImage(buf: Buffer): { ext: "png" | "jpg" | "svg" } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png" };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg" };
  }
  // SVG: Text; muss ein <svg enthalten und darf keinen ausführbaren Inhalt haben.
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4000)).toLowerCase();
  if (head.includes("<svg")) {
    if (/<script|javascript:|on\w+\s*=|<foreignobject/.test(head)) return null;
    return { ext: "svg" };
  }
  return null;
}
