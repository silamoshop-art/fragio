/**
 * Öffentliche Widget-Endpunkte:
 *  - GET /api/widget/:botId/config   Branding + Consent-Infos (AI-Act/DSGVO)
 *  - GET /api/widget/:botId/privacy  Datenschutztext (pro Bot editierbar)
 *
 * Enthalten bewusst KEINE Keys/Origins/Tenant-Daten.
 */
import type { FastifyInstance } from "fastify";
import {
  getBot,
  logConsent,
  suggestedQuestions,
  listBotsByTenant,
  OPERATOR_TENANT_ID,
  getSetting,
} from "../db/repo.js";
import { backendBase } from "../util/embed.js";
import { CONSENT_NOTICE, defaultPrivacyText } from "../legal/privacy.js";

/** Host aus einer URL (ohne www.), leer bei ungültig. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

interface Branding {
  botName?: string;
  primaryColor?: string;
  greeting?: string;
  logoUrl?: string;
}

const DEFAULTS: Required<Branding> = {
  botName: "Website-Assistent",
  primaryColor: "#4f46e5",
  greeting: "Hallo! Frag mich etwas über diese Website.",
  logoUrl: "",
};

export async function widgetConfigRoutes(app: FastifyInstance): Promise<void> {
  // Eigener Website-Bot: liefert die Bot-ID für DIESE Domain (Betreiber-Tenant),
  // damit das Widget auf der Fragio-Seite selbst erscheint — ohne fest verdrahtete
  // ID (funktioniert lokal wie live). Reihenfolge: explizite Einstellung
  // "site_widget_bot_id", sonst der aktive Betreiber-Bot, dessen Crawl-Host dem
  // eigenen Host (PUBLIC_BACKEND_URL) entspricht.
  app.get("/api/widget/site", async () => {
    const forced = getSetting("site_widget_bot_id");
    if (forced) {
      const b = getBot(forced);
      if (b && b.status === "active") return { botId: b.id };
    }
    const ownHost = hostOf(backendBase());
    if (!ownHost) return { botId: null };
    const bots = listBotsByTenant(OPERATOR_TENANT_ID);
    const match = bots.find(
      (b) => b.status === "active" && !b.trial_mode && hostOf(b.crawl_start_url ?? "") === ownHost,
    );
    return { botId: match ? match.id : null };
  });

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
      // Lead-Erfassung + Terminlink (Anforderung A+D)
      leadCapture: !!bot.lead_capture,
      leadIntro:
        bot.lead_intro ||
        "Ich konnte deine Frage nicht aus der Website beantworten. Sollen wir uns bei dir melden? Hinterlasse einfach deine Kontaktdaten.",
      bookingUrl: bot.booking_url || "",
      // Consent (DSGVO/AI-Act)
      consentNotice: CONSENT_NOTICE,
      privacyUrl: `${backendBase()}/privacy.html?bot=${bot.id}`,
    };
  });

  // Die (bis zu) drei häufigsten Besucherfragen als Vorauswahl-Chips — bereinigt.
  app.get<{ Params: { botId: string } }>("/api/widget/:botId/top-questions", async (request, reply) => {
    const bot = getBot(request.params.botId);
    if (!bot) return reply.code(404).send({ error: "Bot nicht gefunden." });
    return { questions: suggestedQuestions(bot.id, 3) };
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
