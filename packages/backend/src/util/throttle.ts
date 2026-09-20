/**
 * Pro-Besucher-Drosselung (Anforderungskatalog C: Missbrauchsschutz).
 *
 * Zusätzlich zum groben Rate-Limit (pro Bot, in server.ts) und zum monatlichen
 * Kontingent begrenzt dies EINEN Besucher (Browser/IP-Hash) auf eine plausible
 * Nutzung: standardmäßig 20 Antworten/Stunde und 40/Tag. Wird das überschritten,
 * wird gedrosselt — und diese Anfragen zählen NICHT gegen das Kontingent des
 * Kunden (der Kunde soll für Missbrauchstraffic nicht bezahlen).
 *
 * In-Memory (Sliding Window). Der Betrieb ist single-process (node:sqlite); für
 * Multi-Prozess wäre ein geteilter Store nötig. Bewusst schlank gehalten.
 */

export interface ThrottleLimits {
  perHour: number;
  perDay: number;
}

export const DEFAULT_VISITOR_LIMITS: ThrottleLimits = { perHour: 20, perDay: 40 };

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// key -> aufsteigend sortierte Zeitstempel der gezählten Treffer (nur < 24h alt).
const hits = new Map<string, number[]>();
let lastSweep = 0;

/** Alte Einträge (> 24h) global aufräumen, damit die Map nicht unbegrenzt wächst. */
function sweep(now: number): void {
  if (now - lastSweep < HOUR) return;
  lastSweep = now;
  for (const [k, arr] of hits) {
    const kept = arr.filter((t) => now - t < DAY);
    if (kept.length) hits.set(k, kept);
    else hits.delete(k);
  }
}

export interface ThrottleResult {
  allowed: boolean;
  /** Sekunden bis wieder eine Anfrage möglich ist (nur wenn !allowed). */
  retryAfterSec?: number;
  scope?: "hour" | "day";
}

/**
 * Prüft UND registriert eine Nutzung für `key` (z. B. `${botId}:${ipHash}`).
 * Gibt allowed=false zurück, wenn ein Fenster-Limit erreicht ist; in dem Fall
 * wird NICHT gezählt (die abgelehnte Anfrage erhöht den Zähler nicht weiter).
 */
export function checkVisitor(
  key: string,
  limits: ThrottleLimits = DEFAULT_VISITOR_LIMITS,
  now = Date.now(),
): ThrottleResult {
  sweep(now);
  const arr = (hits.get(key) || []).filter((t) => now - t < DAY);
  const inHour = arr.filter((t) => now - t < HOUR).length;
  const inDay = arr.length;

  if (inDay >= limits.perDay) {
    hits.set(key, arr);
    const oldest = arr[0];
    return { allowed: false, scope: "day", retryAfterSec: Math.ceil((DAY - (now - oldest)) / 1000) };
  }
  if (inHour >= limits.perHour) {
    hits.set(key, arr);
    const oldestInHour = arr.find((t) => now - t < HOUR)!;
    return { allowed: false, scope: "hour", retryAfterSec: Math.ceil((HOUR - (now - oldestInHour)) / 1000) };
  }
  arr.push(now);
  hits.set(key, arr);
  return { allowed: true };
}

/** Nur für Tests: den In-Memory-Zustand zurücksetzen. */
export function _resetThrottle(): void {
  hits.clear();
  lastSweep = 0;
}

/**
 * Grobe Bot-/Crawler-Erkennung am User-Agent. Solche Anfragen sollen das
 * Kontingent des Kunden nicht belasten (Anforderung C). Bewusst konservativ:
 * lieber einen echten Bot durchlassen als einen echten Menschen sperren.
 */
export function looksLikeBot(userAgent: string | undefined): boolean {
  if (!userAgent) return false;
  return /bot|crawl|spider|slurp|bingpreview|headless|python-requests|curl\/|wget|scrapy|httpclient|facebookexternalhit|semrush|ahrefs/i.test(
    userAgent,
  );
}
