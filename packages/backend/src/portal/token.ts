/**
 * Portal-Session-Token: stateless, signiert mit dem Server-Secret (HMAC-SHA256).
 *
 * SICHERHEITSKERN: Der Token bindet die Session an GENAU EINEN Bot (`bot`). Alle
 * Portal-Endpoints leiten die botId aus dem verifizierten Token ab — nie aus
 * Client-Eingaben. Damit kann ein Kunde niemals einen fremden Bot adressieren.
 */
import crypto from "node:crypto";
import { config } from "../config.js";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

export interface PortalClaims {
  bu: string; // bot_user id
  bot: string; // bot id (Isolationsschlüssel)
  exp: number; // epoch ms
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

export function signPortalToken(botUserId: string, botId: string): string {
  const payload: PortalClaims = { bu: botUserId, bot: botId, exp: Date.now() + TTL_MS };
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = b64url(crypto.createHmac("sha256", config.secretKey).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyPortalToken(token: string): PortalClaims | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac("sha256", config.secretKey).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PortalClaims;
    if (!claims.bot || !claims.bu || !claims.exp || Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
