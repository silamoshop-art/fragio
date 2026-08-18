/**
 * Playwright-basierter Crawler (rendert auch JS-lastige Seiten).
 *
 * - Bleibt auf derselben Origin wie die Start-URL (kein Fremd-Domain-Crawling).
 * - Respektiert robots.txt (robots-parser) für den eigenen User-Agent.
 * - Begrenzt durch maxPages und maxDepth (Kostenschutz / Free-Tier).
 * - BFS über gefundene <a href>-Links.
 */
import { chromium, type Browser } from "playwright";
import robotsParserImport from "robots-parser";

// robots-parser ist ein CommonJS-Modul; unter NodeNext die Aufrufsignatur casten.
const robotsParser = robotsParserImport as unknown as (
  url: string,
  contents: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

export const CRAWLER_UA = "SiteBotCrawler/0.1 (+https://sitebot.example)";

// Für einen Firmen-Chatbot besonders wertvolle Seiten — werden beim Crawlen
// bevorzugt, damit sie auch bei knappem Seitenlimit sicher indexiert werden.
const KEY_PATH =
  /(kontakt|contact|impressum|imprint|team|ueber|über|about|unternehmen|company|karriere|career|jobs|standort|anfahrt|mitarbeiter|lehr)/i;

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  timeoutMs?: number;
  onProgress?: (info: CrawlProgress) => void;
}

export interface CrawlProgress {
  fetched: number;
  queued: number;
  currentUrl: string;
}

export interface CrawledPage {
  url: string;
  html: string;
  depth: number;
}

// Tracking-/Social-Redirect-Parameter: Solche URLs sind KEINE echten Inhaltsseiten,
// sondern getarnte Weiterleitungen zu Facebook/LinkedIn/Ads o. Ä. — auch wenn sie
// technisch auf der eigenen Domain landen. Werden komplett ignoriert (Prompt 13 #1).
const TRACKING_PARAM =
  /(^|[?&])(fbclid|fbid|gclid|gbraid|wbraid|msclkid|yclid|twclid|igshid|mc_cid|mc_eid|trk|trkcampaign|utm_source|utm_medium|utm_campaign|utm_term|utm_content|ref_src|_openstat)=/i;

/** URL für Dedupe normalisieren: Fragment weg, kein Trailing-Slash (außer Root). */
function normalizeUrl(raw: string, base: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Häufige nicht-HTML-Endungen überspringen.
    if (/\.(pdf|jpg|jpeg|png|gif|svg|webp|zip|mp4|mp3|css|js|ico|woff2?)$/i.test(u.pathname)) {
      return null;
    }
    // Tracking-/Social-Redirect-Links verwerfen (auch same-origin getarnt).
    if (u.search && TRACKING_PARAM.test(u.search)) return null;
    let s = u.toString();
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

// Titel typischer Fehler-/404-Seiten: solche Seiten NICHT indexieren (Prompt 13 #2).
const NOT_FOUND_TITLE =
  /(page not found|not found|404|nicht gefunden|seite nicht gefunden|fehler\s*404|error\s*404|no encontrada|introuvable)/i;

async function loadRobots(origin: string): Promise<ReturnType<typeof robotsParser>> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, { headers: { "user-agent": CRAWLER_UA } });
    const body = res.ok ? await res.text() : "";
    return robotsParser(robotsUrl, body);
  } catch {
    // robots.txt nicht erreichbar -> nichts blockiert.
    return robotsParser(robotsUrl, "");
  }
}

export async function crawl(startUrl: string, opts: CrawlOptions = {}): Promise<CrawledPage[]> {
  const maxPages = opts.maxPages ?? 50;
  const maxDepth = opts.maxDepth ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const start = normalizeUrl(startUrl, startUrl);
  if (!start) throw new Error(`Ungültige Start-URL: ${startUrl}`);
  const origin = new URL(start).origin;

  const robots = await loadRobots(origin);
  const results: CrawledPage[] = [];
  const seen = new Set<string>([start]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: CRAWLER_UA });

    while (queue.length && results.length < maxPages) {
      const { url, depth } = queue.shift()!;

      if (robots.isAllowed(url, CRAWLER_UA) === false) continue;

      opts.onProgress?.({ fetched: results.length, queued: queue.length, currentUrl: url });

      const page = await context.newPage();
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // HTTP-Fehler (404/410/5xx …) -> Seite NICHT indexieren, Links nicht folgen.
        if (response && response.status() >= 400) {
          console.warn(`  ⚠️  ${url} übersprungen (HTTP ${response.status()}).`);
          continue;
        }
        // kurzes Nachladen für JS-gerenderte Inhalte
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        // Fehler-/404-Seiten anhand des Titels erkennen (viele Seiten liefern 200 + „Not Found").
        const title = await page.title().catch(() => "");
        if (title && NOT_FOUND_TITLE.test(title)) {
          console.warn(`  ⚠️  ${url} übersprungen (Fehlerseite: "${title.slice(0, 60)}").`);
          continue;
        }
        const html = await page.content();
        results.push({ url, html, depth });

        // Links einsammeln (nur wenn noch Tiefe/Budget übrig).
        if (depth < maxDepth && results.length < maxPages) {
          const hrefs = await page.$$eval("a[href]", (as) =>
            as.map((a) => (a as HTMLAnchorElement).getAttribute("href") || ""),
          );
          // Wichtige Seiten (Kontakt/Impressum/Team/…) priorisieren: sie hängen oft
          // im Footer und würden bei niedrigem Seitenlimit sonst nie gecrawlt.
          const priority: { url: string; depth: number }[] = [];
          const normal: { url: string; depth: number }[] = [];
          for (const href of hrefs) {
            const abs = normalizeUrl(href, url);
            if (!abs || seen.has(abs)) continue;
            if (new URL(abs).origin !== origin) continue; // gleiche Origin only
            seen.add(abs);
            const item = { url: abs, depth: depth + 1 };
            (KEY_PATH.test(abs) ? priority : normal).push(item);
          }
          // Priorisierte an den Anfang der Queue, Rest ans Ende.
          queue.unshift(...priority);
          queue.push(...normal);
        }
      } catch (err) {
        // Einzelne Seite fehlgeschlagen -> überspringen, Crawl fortsetzen.
        console.warn(`  ⚠️  ${url} übersprungen: ${(err as Error).message}`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser?.close().catch(() => {});
  }

  return results;
}
