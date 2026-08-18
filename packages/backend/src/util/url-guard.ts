/**
 * SSRF-Schutz für nutzergetriggerte Crawls (Demo-Onboarding).
 *
 * Da beliebige Besucher eine URL eingeben, die unser Server abruft, müssen
 * interne/private Ziele blockiert werden (localhost, private IP-Ranges, Metadaten-
 * Endpunkte von Cloud-Providern etc.).
 *
 * Hinweis (MVP-Grenze): Diese Prüfung arbeitet auf Host-/IP-Literal-Ebene. Ein
 * Angreifer könnte über DNS-Rebinding einen öffentlichen Namen auf eine private
 * IP zeigen lassen. Für Produktion zusätzlich die aufgelöste IP prüfen bzw. den
 * Crawler in einem netzwerkisolierten Container betreiben.
 */

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /\.local$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./, // link-local (inkl. Cloud-Metadaten 169.254.169.254)
  /^0\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export interface UrlCheck {
  ok: boolean;
  reason?: string;
  normalized?: string;
}

export function checkPublicHttpUrl(input: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "Keine gültige URL." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: "Nur http/https erlaubt." };
  }
  const host = u.hostname;
  if (!host) return { ok: false, reason: "Kein Host." };
  for (const re of PRIVATE_HOST_PATTERNS) {
    if (re.test(host)) {
      return { ok: false, reason: "Interne/private Adressen sind nicht erlaubt." };
    }
  }
  return { ok: true, normalized: u.toString() };
}
