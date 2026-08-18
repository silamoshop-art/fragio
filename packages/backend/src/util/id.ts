/** Kleine ID-/Hash-Helfer. */
import crypto from "node:crypto";

/** URL-sichere Zufalls-ID (Default 16 Byte -> 22 Zeichen base64url). */
export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Öffentliche botId (kurz, gut kopierbar). */
export function newBotId(): string {
  return "bot_" + randomId(9);
}

/** Management-API-Key eines Tenants (geheim, wird nur als Hash gespeichert). */
export function newApiKey(): string {
  return "sk_" + randomId(24);
}

/** SHA-256 Hex (für API-Key-Hash und Content-Hashes). */
export function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}
