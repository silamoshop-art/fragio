/**
 * Kontaktformular der Info-Website (Umbau). Kein externer Dienst: die Nachricht
 * wird über den eigenen Server an das Betreiber-Postfach zugestellt (sendOperatorEmail,
 * Ziel = in der Mail-Konfiguration hinterlegte Adresse, z. B. peter.fragio@gmail.com).
 *
 * Schutz ohne Tracker/CAPTCHA:
 *  - Honeypot-Feld `website`: ausgefüllt => still verwerfen (so tun als ob ok).
 *  - Zeitsperre: Absenden < 3 s nach Laden (nur wenn `ts` gesetzt) => verwerfen.
 *  - Rate-Limit pro IP-Hash (zusätzlich zum globalen Limit).
 *  - Nur von fragio.at (isFragioOrigin).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendOperatorEmail } from "../notify/email.js";
import { isFragioOrigin } from "../util/origin.js";
import { sha256 } from "../util/id.js";

const MIN_FILL_MS = 3000;
// Einfaches In-Memory-Rate-Limit: höchstens 5 Nachrichten pro IP-Hash je Stunde.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

function rateLimited(ipHash: string): boolean {
  const now = Date.now();
  const arr = (hits.get(ipHash) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_WINDOW) {
    hits.set(ipHash, arr);
    return true;
  }
  arr.push(now);
  hits.set(ipHash, arr);
  return false;
}

const OK_HTML = `<!doctype html><html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" /><title>Danke — Fragio</title>
<link rel="stylesheet" href="/site.css" /></head><body>
<main id="main"><section class="section"><div class="wrap" style="max-width:640px">
<h1>Danke, Ihre Nachricht ist angekommen.</h1>
<p class="section-sub">Ich antworte, so schnell es geht. <a href="/">Zur Startseite</a></p>
</div></section></main></body></html>`;

export async function contactRoutes(app: FastifyInstance): Promise<void> {
  // Zusätzlich zu JSON auch klassische Formular-Posts (ohne JavaScript) annehmen.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      try {
        const obj: Record<string, string> = {};
        for (const [k, v] of new URLSearchParams(body as string)) obj[k] = v;
        done(null, obj);
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  app.post("/api/contact", async (request, reply) => {
    if (!isFragioOrigin(request.headers.origin)) {
      return reply.code(403).send({ error: "Nur auf fragio.at verfügbar." });
    }
    const isForm = (request.headers["content-type"] || "").includes("x-www-form-urlencoded");
    const parsed = z
      .object({
        name: z.string().max(120).optional(),
        email: z.string().email().max(200),
        message: z.string().min(1).max(2000),
        website: z.string().optional(), // Honeypot
        ts: z.string().optional(),
      })
      .safeParse(request.body);

    const ok = () =>
      isForm
        ? reply.code(200).header("Content-Type", "text/html; charset=utf-8").send(OK_HTML)
        : reply.send({ ok: true });

    if (!parsed.success) {
      return reply.code(400).send({ error: "Bitte E-Mail und Nachricht angeben." });
    }
    const d = parsed.data;

    // Honeypot ausgefüllt -> still verwerfen (nach außen "ok").
    if (d.website && d.website.trim()) return ok();
    // Zu schnell abgeschickt -> verwerfen (nur wenn ts gesetzt, sonst kein JS).
    if (d.ts) {
      const t = Number(d.ts);
      if (Number.isFinite(t) && Date.now() - t < MIN_FILL_MS) return ok();
    }

    const ipHash = sha256(request.ip || "");
    if (rateLimited(ipHash)) {
      return reply.code(429).send({ error: "Zu viele Nachrichten. Bitte später erneut." });
    }

    const subject = "Fragio-Kontakt: neue Nachricht";
    const body =
      `Neue Nachricht über das Kontaktformular (fragio.at):\n\n` +
      `Name: ${d.name?.trim() || "(nicht angegeben)"}\n` +
      `E-Mail: ${d.email.trim()}\n\n` +
      `${d.message.trim()}\n`;
    try {
      await sendOperatorEmail(subject, body);
    } catch (e) {
      request.log.error(e);
      return reply.code(502).send({ error: "Nachricht konnte nicht zugestellt werden." });
    }
    return ok();
  });
}
