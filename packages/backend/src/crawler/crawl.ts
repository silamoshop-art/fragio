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

export const CRAWLER_UA = "SiteBotCrawler/0.1 (+https://fragio.at)";

// Für einen Firmen-Chatbot besonders wertvolle Seiten — werden beim Crawlen
// bevorzugt, damit sie auch bei knappem Seitenlimit sicher indexiert werden.
// Enthält Kontakt-/Über-uns-Muster UND typische Inhalts-/Angebotsseiten
// (Preise, Klassen, Kurse, Leistungen, FAQ), damit z. B. Preislisten sicher vor
// dem Seitenlimit gecrawlt werden.
const KEY_PATH =
  /(kontakt|contact|impressum|imprint|team|ueber|über|about|unternehmen|company|karriere|career|jobs|standort|anfahrt|mitarbeiter|lehr|preis|tarif|kosten|kurs|klasse|f[üu]hrerschein|ausbildung|leistung|angebot|service|produkt|faq|objekt|immobil)/i;

// GEGENTEIL: Seiten mit geringem Chatbot-Nutzen, die aber oft in großer Zahl (fast
// duplizierte Query-Varianten) verlinkt sind und sonst das Seitenbudget auffressen —
// Termin-/Buchungs-/Kalenderseiten. Werden ganz ans Ende der Queue gestellt UND in
// der Anzahl gedeckelt, damit Inhaltsseiten vorher drankommen (realer Fall sauer.at:
// dutzende /terminuebersicht.X-Varianten verdrängten Preisliste & Klassenseiten).
const LOW_PATH = /(termin|calendar|kalender|buchung|buchen|booking|warenkorb|checkout|cart)/i;
const MAX_LOW_PAGES = 3; // höchstens so viele Kalender-/Buchungsseiten crawlen

// TOP-Priorität: dedizierte Preislisten-/Tarifseiten. Preisfragen gehören zu den
// häufigsten Nutzeranfragen — diese Seiten (und die dort verlinkten Tarif-PDFs)
// MÜSSEN vor dem Seitenlimit gecrawlt werden, sonst fehlt genau die Preisinfo.
const PRICE_PATH = /(preislist|preise|\bpreis\b|tarif|kostenuebersicht|preisuebersicht)/i;

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

export interface CrawlResult {
  pages: CrawledPage[];
  /** Same-site .pdf-Links (dedupliziert, auf MAX_PDFS begrenzt), für die PDF-Indexierung. */
  pdfUrls: string[];
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
    // Häufige nicht-HTML-Endungen überspringen (inkl. Download-Formate wie ICS/
    // Office/CSV — sonst löst page.goto einen Download aus: "Download is starting").
    if (/\.(pdf|jpe?g|png|gif|svg|webp|zip|rar|7z|mp4|mp3|avi|mov|css|js|ico|woff2?|ics|xlsx?|docx?|pptx?|csv|xml|rss)$/i.test(u.pathname)) {
      return null;
    }
    // Download-/Kalender-Export-Parameter verwerfen (lösen ebenfalls Downloads aus
    // bzw. sind reine Kalender-Feeds ohne Inhalt für den Chatbot).
    if (/[?&](calendar|ical|ics|download|export|attachment|dl)=/i.test(u.search)) return null;
    // Tracking-/Social-Redirect-Links verwerfen (auch same-origin getarnt).
    if (u.search && TRACKING_PARAM.test(u.search)) return null;
    let s = u.toString();
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return null;
  }
}

/**
 * Vergleichs-Host ohne führendes "www." (klein). Viele Sites verlinken intern
 * ausschließlich die www-Variante (oder leiten die apex-Domain auf www um). Ohne
 * diese Normalisierung würde der reine `origin`-Vergleich ALLE internen Links als
 * "fremde Domain" verwerfen (realer Fall fahrschule-hoerl.at → nur 1 Seite gecrawlt).
 */
function siteHost(hostname: string): string {
  return hostname.replace(/^www\./i, "").toLowerCase();
}

/**
 * Dedupe-Schlüssel: host (ohne www) + Pfad + Query, protokoll-unabhängig. So wird
 * dieselbe Seite unter www und non-www (bzw. http/https) nicht doppelt gecrawlt.
 */
function dedupeKey(u: string): string {
  try {
    const url = new URL(u);
    return siteHost(url.hostname) + url.pathname + url.search;
  } catch {
    return u;
  }
}

// Max. Anzahl PDFs pro Website (Zeit-/Speicherschutz, Prompt 16 #2). Bewusst
// großzügig: Fahrschulen/Kanzleien hinterlegen oft EIN PDF pro Klasse/Leistung
// (Infozettel, Tarifblätter) — bei zu niedrigem Cap fehlt sonst genau das mit dem
// gesuchten Preis (realer Fall sauer.at: F-Infozettel/Tarifblatt fielen bei 10 raus).
const MAX_PDFS = 25;

/**
 * Erkennt einen SAME-SITE-Link auf eine .pdf-Datei (für die PDF-Indexierung).
 * Gibt die absolute PDF-URL zurück oder null. Fremd-Domain- und Tracking-PDFs
 * werden — wie normale Links — verworfen.
 */
function pdfLinkIfSameSite(href: string, base: string, originHost: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!/\.pdf$/i.test(u.pathname)) return null;
    if (u.search && TRACKING_PARAM.test(u.search)) return null;
    if (siteHost(u.hostname) !== originHost) return null;
    u.hash = "";
    return u.toString();
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

export async function crawl(startUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 50;
  const maxDepth = opts.maxDepth ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20000;

  const start = normalizeUrl(startUrl, startUrl);
  if (!start) throw new Error(`Ungültige Start-URL: ${startUrl}`);
  const origin = new URL(start).origin;
  // Maßgeblicher Site-Host (ohne www). Wird nach dem Laden der Startseite ggf. auf
  // den finalen Host nach Weiterleitung aktualisiert (apex→www oder Domainwechsel).
  let originHost = siteHost(new URL(start).hostname);

  const robots = await loadRobots(origin);
  const results: CrawledPage[] = [];
  const pdfUrls = new Set<string>(); // same-site PDF-Links (Prompt 16 #2)
  const seen = new Set<string>([dedupeKey(start)]);
  const queue: { url: string; depth: number }[] = [{ url: start, depth: 0 }];
  let lowQueued = 0; // gedeckelte Anzahl Kalender-/Buchungsseiten (LOW_PATH)

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
        // Beim allerersten (Start-)Seitenaufruf den maßgeblichen Host aus der FINALEN
        // URL nach Weiterleitungen übernehmen (z. B. apex → www) — sonst würden die
        // internen Links danach fälschlich als "fremde Domain" verworfen.
        if (results.length === 0 && response) {
          try {
            originHost = siteHost(new URL(response.url()).hostname);
          } catch {
            /* Fallback: originHost unverändert */
          }
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
          // Vier Prioritäten: Preislisten (TOP) > Inhalts-/Angebotsseiten (KEY_PATH)
          // > Normal > Kalender-/Buchungsseiten (LOW, gedeckelt, zuletzt).
          const pricePriority: { url: string; depth: number }[] = [];
          const priority: { url: string; depth: number }[] = [];
          const normal: { url: string; depth: number }[] = [];
          const low: { url: string; depth: number }[] = [];
          for (const href of hrefs) {
            // Same-site PDF-Links separat sammeln (normalizeUrl verwirft .pdf für
            // die Seiten-Queue). Set dedupliziert; Cap MAX_PDFS.
            if (pdfUrls.size < MAX_PDFS) {
              const pdf = pdfLinkIfSameSite(href, url, originHost);
              if (pdf) pdfUrls.add(pdf);
            }
            const abs = normalizeUrl(href, url);
            if (!abs) continue;
            const key = dedupeKey(abs);
            if (seen.has(key)) continue;
            // Gleiche Site (www egal); verwirft echte Fremd-Domains weiterhin.
            if (siteHost(new URL(abs).hostname) !== originHost) continue;
            // Fehlerhaft ausgezeichnete Links (z. B. href="www.firma.at/x" OHNE
            // Protokoll) werden vom Browser als RELATIV aufgelöst -> der Host landet
            // als Pfadsegment (…/www.firma.at/x) und rekursiert bei jedem Schritt
            // weiter zu 404-Müll. Solche URLs verwerfen.
            const segs = new URL(abs).pathname.toLowerCase().split("/");
            if (segs.includes(originHost) || segs.includes("www." + originHost)) continue;
            seen.add(key);
            const item = { url: abs, depth: depth + 1 };
            // Klassifikation NUR anhand des Pfads (nicht der Query!) — sonst würde
            // z. B. "?fuehrerschein=nein" an einer Kalender-URL fälschlich als
            // Inhaltsseite gelten. LOW zuerst prüfen: Kalender/Buchung gewinnt.
            const path = new URL(abs).pathname.toLowerCase();
            if (LOW_PATH.test(path)) {
              if (lowQueued < MAX_LOW_PAGES) {
                low.push(item);
                lowQueued++;
              }
            } else if (PRICE_PATH.test(path)) {
              pricePriority.push(item);
            } else if (KEY_PATH.test(path)) {
              priority.push(item);
            } else {
              normal.push(item);
            }
          }
          // Reihenfolge: Preislisten ganz vorne, dann Inhalt, dann Normal, Kalender zuletzt.
          queue.unshift(...priority);
          queue.unshift(...pricePriority); // zuletzt unshift = frontmost
          queue.push(...normal);
          queue.push(...low);
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

  return { pages: results, pdfUrls: [...pdfUrls] };
}
