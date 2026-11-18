/**
 * Origin-/Domain-Whitelist-Logik für die Widget-Endpunkte.
 *
 * Ein Bot hinterlegt erlaubte Domains (bots.allowed_origins), z. B. "firma.at"
 * oder "https://www.firma.at". Requests vom Widget tragen einen Origin-Header;
 * der wird gegen die Whitelist geprüft — sowohl für CORS als auch serverseitig
 * (gegen Snippet-Diebstahl).
 *
 * Leere Whitelist = überall erlaubt (nur für Tests/Demo sinnvoll).
 */

/** Hostname aus Origin/Domain-Eintrag extrahieren (protokoll-tolerant). */
function toHost(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return "";
  if (!/^https?:\/\//.test(v)) v = "http://" + v;
  try {
    return new URL(v).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Prüft, ob ein Request-Origin gegen die Whitelist erlaubt ist. */
export function isOriginAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true; // leere Liste => offen
  if (!origin) return false; // Whitelist gesetzt, aber kein Origin => ablehnen
  const originHost = toHost(origin);
  if (!originHost) return false;
  return allowed.some((entry) => {
    const h = toHost(entry);
    return h && originHost === h;
  });
}

/**
 * Harte Sperre (Umbau zur reinen Info-Website): Widget und Chat-API dürfen
 * AUSSCHLIESSLICH von fragio.at aus genutzt werden. Fragio wird nicht mehr für
 * fremde Websites bereitgestellt, daher werden fremde `data-bot-id`/Origins
 * abgelehnt. Lokale Entwicklungs-Origins bleiben erlaubt; fehlt der Origin-Header
 * (Server-zu-Server, keine Browser-Einbettung), wird nicht blockiert.
 */
export function isFragioOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  const host = toHost(origin); // entfernt bereits ein führendes "www."
  if (!host) return false;
  return host === "fragio.at" || host === "localhost" || host === "127.0.0.1";
}

export function parseAllowedOrigins(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/** botId aus Widget-Request-URLs extrahieren (für CORS im onRequest-Hook). */
export function botIdFromUrl(url: string): string | null {
  // /api/chat/:botId  oder  /api/widget/:botId/config
  const m =
    /^\/api\/chat\/([^/?]+)/.exec(url) ||
    /^\/api\/widget\/([^/?]+)\/config/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}
