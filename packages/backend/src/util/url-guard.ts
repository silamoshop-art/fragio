/**
 * SSRF-Schutz für nutzergetriggerte Crawls (Demo-Onboarding).
 *
 * Da beliebige Besucher eine URL eingeben, die unser Server abruft, müssen
 * interne/private Ziele blockiert werden (localhost, private IP-Ranges, Metadaten-
 * Endpunkte von Cloud-Providern etc.).
 *
 * checkPublicHttpUrl arbeitet auf Host-/IP-Literal-Ebene. Zusätzlich lösen
 * hostIsPublic()/isPublicIp() (unten) den Namen auf und prüfen die echte IP; der
 * Demo-Crawler wendet das auf JEDE Anfrage an (auch Weiterleitungen/Unterressourcen)
 * und erlaubt nur Port 80/443. Restrisiko: Zwischen unserer Auflösung und der des
 * Browsers liegt ein kurzes Zeitfenster (DNS-Rebinding) — die Port-Beschränkung
 * hält interne Dienste (:3000, Caddy :2019) auch dann ab.
 */
import dns from "node:dns/promises";
import net from "node:net";

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
  // Nicht-gepunktete IP-Kodierungen (dezimal wie "2130706433" = 127.0.0.1, hex
  // "0x7f000001", oktal) umgehen die Muster unten, werden vom Browser aber zu (oft
  // privaten) IPs aufgelöst. Ein echter öffentlicher Host hat immer einen Punkt und
  // eine Buchstaben-TLD -> reine Ziffern-/Hex-Hosts und die Null-IPv6 blocken.
  if (/^\d+$/.test(host) || /^0x/i.test(host) || host === "::" || host === "[::]") {
    return { ok: false, reason: "Ungültige/gefährliche Host-Kodierung." };
  }
  for (const re of PRIVATE_HOST_PATTERNS) {
    if (re.test(host)) {
      return { ok: false, reason: "Interne/private Adressen sind nicht erlaubt." };
    }
  }
  return { ok: true, normalized: u.toString() };
}

// ── Aufgelöste-IP-Prüfung (SSRF-Härtung für die öffentliche Demo) ────────────────
// Die Host-Literal-Prüfung oben schützt nicht gegen Namen, die auf private IPs
// zeigen (z. B. localtest.me -> 127.0.0.1, DNS-Rebinding, Weiterleitungen).
// Deshalb wird zusätzlich JEDE angefragte Adresse zur IP aufgelöst und geprüft.

/** IPv6-Adresse in 8 Gruppen à 16 Bit auflösen (inkl. "::" und eingebettetem IPv4). */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    if (o.some((n) => !(n >= 0 && n <= 255))) return null;
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if ((halves.length === 1 && head.length !== 8) || fill < 0) return null;
  const all = halves.length === 2 ? [...head, ...Array(fill).fill("0"), ...tail] : head;
  const groups = all.map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}

function isPublicIpv4(o: number[]): boolean {
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local / Cloud-Metadaten
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 + 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false; // Benchmark/Doku
  if (a === 203 && b === 0) return false; // 203.0.113.0/24
  if (a >= 224) return false; // Multicast + reserviert + Broadcast
  return true;
}

/** Ist diese IP-Adresse (v4 oder v6) eine öffentlich geroutete Adresse? */
export function isPublicIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  if (net.isIPv4(clean)) return isPublicIpv4(clean.split(".").map(Number));
  if (!net.isIPv6(clean)) return false;
  const g = ipv6Groups(clean);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) -> den IPv4-Teil prüfen.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isPublicIpv4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
  }
  if (g.slice(0, 7).every((x) => x === 0)) return false; // :: und ::1
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 (link-local)
  if ((g[0] & 0xff00) === 0xff00) return false; // Multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // Doku
  if (g[0] === 0x0064 && g[1] === 0xff9b) return false; // NAT64
  return true;
}

const hostCache = new Map<string, { ok: boolean; exp: number }>();

/**
 * Löst den Host per DNS auf und prüft ALLE Adressen. Ein Fehler (Name nicht
 * auflösbar) gilt als "nicht öffentlich" -> fail-closed. Kurzes Caching, damit
 * eine Seite mit vielen Unterressourcen nicht ständig neu auflöst.
 */
export async function hostIsPublic(host: string): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h) return false;
  if (net.isIP(h)) return isPublicIp(h);
  const hit = hostCache.get(h);
  if (hit && hit.exp > Date.now()) return hit.ok;
  let ok = false;
  try {
    const addrs = await dns.lookup(h, { all: true, verbatim: true });
    ok = addrs.length > 0 && addrs.every((a) => isPublicIp(a.address));
  } catch {
    ok = false;
  }
  hostCache.set(h, { ok, exp: Date.now() + (ok ? 5 * 60_000 : 30_000) });
  if (hostCache.size > 2000) hostCache.clear();
  return ok;
}

/**
 * fetch mit SSRF-Schutz: folgt Weiterleitungen manuell (max. 5) und prüft vor
 * JEDEM Schritt Schema, Port und aufgelöste IP. Gibt null zurück, wenn ein
 * Schritt nicht erlaubt ist.
 */
export async function guardedFetch(
  url: string,
  init: { headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      return null;
    }
    if (!checkPublicHttpUrl(current).ok || !isAllowedPort(u) || !(await hostIsPublic(u.hostname))) {
      return null;
    }
    const res = await fetch(current, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location")!, current).toString();
      await res.body?.cancel().catch(() => {});
      continue;
    }
    return res;
  }
  return null;
}

/** Nur Standard-Ports (80/443): schließt interne Dienste wie :3000 oder Caddy :2019 aus. */
export function isAllowedPort(u: URL): boolean {
  return u.port === "" || u.port === "80" || u.port === "443";
}
