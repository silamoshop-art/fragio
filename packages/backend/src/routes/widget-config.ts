/**
 * Öffentliche Widget-Endpunkte:
 *  - GET /api/widget/:botId/config   Branding + Consent-Infos (AI-Act/DSGVO)
 *  - GET /api/widget/:botId/privacy  Datenschutztext (pro Bot editierbar)
 *
 * Enthalten bewusst KEINE Keys/Origins/Tenant-Daten.
 */
import type { FastifyInstance } from "fastify";
import { getBot, logConsent } from "../db/repo.js";
import { backendBase } from "../util/embed.js";
import { CONSENT_NOTICE, defaultPrivacyText } from "../legal/privacy.js";

interface Branding {
  botName?: string;
  primaryColor?: string;
  greeting?: string;
  logoUrl?: string;
}

const DEFAULTS: Required<Branding> = {
  botName: "Website-Assistent",
  primaryColor: "#4f46e5",
  greeting: "Hallo! 👋 Frag mich etwas über diese Website.",
  logoUrl: "",
};

export async function widgetConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { botId: string } }>("/api/widget/:botId/config", async (request, reply) => {
    const bot = getBot(request.params.botId);
    if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });

    let branding: Branding = {};
    try {
      branding = JSON.parse(bot.branding) as Branding;
    } catch {
      branding = {};
    }

    return {
      botId: bot.id,
      status: bot.status,
      botName: branding.botName || DEFAULTS.botName,
      primaryColor: branding.primaryColor || DEFAULTS.primaryColor,
      greeting: branding.greeting || DEFAULTS.greeting,
      logoUrl: branding.logoUrl || DEFAULTS.logoUrl,
      aiNotice: "Dies ist ein KI-Chatbot. Antworten können Fehler enthalten.",
      // Consent (DSGVO/AI-Act)
      consentNotice: CONSENT_NOTICE,
      privacyUrl: `${backendBase()}/privacy.html?bot=${bot.id}`,
    };
  });

  app.get<{ Params: { botId: string } }>("/api/widget/:botId/privacy", async (request, reply) => {
    const bot = getBot(request.params.botId);
    if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
    let branding: Branding = {};
    try {
      branding = JSON.parse(bot.branding) as Branding;
    } catch {
      branding = {};
    }
    const company = branding.botName || bot.name || "";
    return {
      botName: branding.botName || DEFAULTS.botName,
      privacyText: bot.privacy_text || defaultPrivacyText(company, bot.retention_days),
    };
  });

  // Anonymer Consent-Nachweis: das Widget meldet eine erteilte Zustimmung.
  // Bewusst OHNE personenbezogene Daten (keine IP, kein User-Agent) — nur Bot + Zeit.
  app.post<{ Params: { botId: string } }>("/api/widget/:botId/consent", async (request, reply) => {
    const bot = getBot(request.params.botId);
    if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
    logConsent(bot.id);
    return { ok: true };
  });
}
