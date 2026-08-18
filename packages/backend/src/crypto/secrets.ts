/**
 * Verschlüsselung der von Kunden hinterlegten API-Keys.
 *
 * Anforderung: API-Keys NIEMALS im Klartext in der DB. Wir nutzen AES-256-GCM
 * (authenticated encryption) mit dem serverseitigen `config.secretKey` (32 Byte).
 *
 * Speicherformat (ein String, in DB-Spalte `bots.encrypted_api_key`):
 *   v1:<iv_base64>:<authTag_base64>:<ciphertext_base64>
 *
 * Der Versions-Prefix erlaubt späteren Algorithmus-/Key-Rotationswechsel.
 */
import crypto from "node:crypto";
import { config } from "../config.js";

const ALGO = "aes-256-gcm";
const VERSION = "v1";

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12); // 96-bit IV, empfohlen für GCM
  const cipher = crypto.createCipheriv(ALGO, config.secretKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Ungültiges Secret-Format oder unbekannte Version.");
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGO, config.secretKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Nur die letzten 4 Zeichen zeigen (für Dashboard-Anzeige "sk-...ab12"). */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 4) return "…";
  return "…" + plaintext.slice(-4);
}
