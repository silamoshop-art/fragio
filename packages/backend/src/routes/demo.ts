/**
 * POST /api/demo/start — öffentlicher Self-Service-Demo-Crawl (Onboarding).
 *
 * Ablauf: Besucher gibt eine Website-Adresse ein -> Server crawlt einige
 * öffentliche Seiten -> legt einen kurzlebigen Trial-Bot an (20 Anfragen, 24 h)
 * -> Besucher testet den echten Bot über /api/chat/:botId.
 *
 * Sicherheit (bewusst streng, da von beliebigen Besuchern auslösbar):
 *  - SSRF-Schutz: checkPublicHttpUrl blockt localhost/private IPs/Metadaten.
 *  - Pro-IP-Drossel (in-memory, gleitendes Fenster) gegen Crawl-Spam.
 *  - Globale Obergrenze gleichzeitiger Crawls (Playwright ist ressourcenintensiv).
 *  - Enges Seiten-Budget (DEMO_MAX_PAGES) und hartes Trial-Kontingent (20).
 *  - KEIN Konto, KEIN Login, KEINE Secrets im Client: der Browser bekommt nur
 *    die Bot-ID zurück; der KI-Key bleibt ausschließlich serverseitig (Trial-Key).
 *  - Leere Wissensbasis (Crawl fehlgeschlagen) -> Bot wird sofort wieder gelöscht.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { checkPublicHttpUrl } from "../util/url-guard.js";
import { getOrCreateSystemTenant, createBot, deleteBot, setCrawlResult } from "../db/repo.js";
import { crawlAndIndex } from "../crawler/index.js";

/** Geteilte Kennung des Demo-/System-Tenants — identisch mit dem Cleanup in cron.ts. */
export const DEMO_TENANT_EMAIL = "demo@sitebot.local";

/** Genug Seiten für eine aussagekräftige Vorschau (inkl. Kontakt/Impressum), aber
 *  weiterhin ressourcenschonend. Kontaktseiten werden im Crawler vorgezogen. */
const DEMO_MAX_PAGES = 10;
/** Höchstens so viele verlinkte PDFs (z. B. Preislisten) für die Vorschau lesen. */
const DEMO_MAX_PDFS = 3;
/** Test-Kontingent: harte Obergrenze pro Demo-Bot. */
const DEMO_REQUEST_CAP = 20;
/** Lebensdauer: 1 Tag; der Cleanup-Cron löscht Demo-Bots endgültig. */
const DEMO_TRIAL_DAYS = 1;

/** Pro-IP-Drossel: maximal so viele Demo-Crawls je Zeitfenster. */
const IP_MAX_PER_WINDOW = 6;
const IP_WINDOW_MS = 60 * 60 * 1000; // 1 Stunde
/** Globale Obergrenze gleichzeitig laufender Demo-Crawls (Playwright-Last). */
const MAX_CONCURRENT_CRAWLS = 2;

// In-memory Zustand (bewusst nicht in der DB: nur Missbrauchsschutz, Reset bei Neustart ok).
const ipHits = new Map<string, number[]>();
let activeCrawls = 0;

function ipThrottled(ip: string): boolean {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_MAX_PER_WINDOW) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  // Gelegentliches Aufräumen, damit die Map nicht unbegrenzt wächst.
  if (ipHits.size > 5000) {
    for (const [k, v] of ipHits) {
      if (v.every((t) => now - t >= IP_WINDOW_MS)) ipHits.delete(k);
    }
  }
  return false;
}

const BodySchema = z.object({ url: z.string().min(3).max(2048) });

/** Adresse ohne Schema -> https:// voranstellen; danach hart validieren. */
function normalizeInputUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return "https://" + trimmed.replace(/^\/+/, "");
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return url;
  }
}

export async function demoRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/demo/start", async (request: FastifyRequest, reply) => {
    const parsed = BodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Bitte eine gültige Website-Adresse angeben." });
    }

    const normalized = normalizeInputUrl(parsed.data.url);
    const check = checkPublicHttpUrl(normalized);
    if (!check.ok) {
      return reply.code(400).send({ error: check.reason || "Adresse nicht erlaubt." });
    }
    const startUrl = check.normalized || normalized;

    if (ipThrottled(request.ip)) {
      return reply.code(429).send({
        error: "Zu viele Test-Crawls von dieser Verbindung. Bitte später erneut versuchen.",
      });
    }
    if (activeCrawls >= MAX_CONCURRENT_CRAWLS) {
      return reply.code(503).send({
        error: "Gerade sind viele Vorschauen aktiv. Bitte in einer Minute erneut versuchen.",
      });
    }

    // Ab hier SSE: Fortschritt streamen, Verbindung offen halten.
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

    const domain = domainOf(startUrl);
    const tenantId = getOrCreateSystemTenant(DEMO_TENANT_EMAIL);
    const bot = createBot({
      tenantId,
      name: `Demo · ${domain}`,
      startUrl,
      maxPages: DEMO_MAX_PAGES,
      allowedOrigins: [], // Demo-Chat von der Landingpage aus; Kontingent + TTL begrenzen den Missbrauch.
      trialMode: true,
      trialDays: DEMO_TRIAL_DAYS,
      trialRequestCap: DEMO_REQUEST_CAP,
    });

    activeCrawls++;
    let done = false;
    try {
      const result = await crawlAndIndex(
        bot,
        (p) => {
          if (p.phase === "crawling" && p.currentUrl) {
            send("progress", { url: p.currentUrl, fetched: p.fetched });
          }
        },
        { maxPdfs: DEMO_MAX_PDFS },
      );
      setCrawlResult(bot.id, "ok", null);
      done = true;
      send("done", {
        botId: bot.id,
        pageCount: result.pages,
        domain,
        remaining: DEMO_REQUEST_CAP,
      });
    } catch (err) {
      // Leere/gescheiterte Demo nicht liegen lassen -> sofort löschen (nichts bleibt am Server).
      try {
        deleteBot(bot.id);
      } catch {
        /* ignore */
      }
      if (!done) {
        const msg = (err as Error).message || "Website konnte nicht eingelesen werden.";
        request.log.warn({ err }, "Demo-Crawl fehlgeschlagen");
        send("error", {
          message:
            "Die Website konnte nicht eingelesen werden — sie ist evtl. nicht erreichbar, " +
            "blockiert automatisierte Zugriffe oder enthält zu wenig Text. (" + msg + ")",
        });
      }
    } finally {
      activeCrawls = Math.max(0, activeCrawls - 1);
      res.end();
    }
  });
}
