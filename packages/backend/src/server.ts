/**
 * Fastify-Server — zentrales Backend.
 *
 * Sicherheit (Schritt 8):
 *  - CORS dynamisch pro Bot: Für Widget-Endpunkte (/api/chat/:botId,
 *    /api/widget/:botId/config) wird der Request-Origin gegen die
 *    Domain-Whitelist des Bots geprüft (nicht "*"). Leere Whitelist => offen.
 *  - Rate-Limiting: pro botId (Chat) bzw. pro IP (Demo/Admin) — Kostenschutz.
 *  - Auth: API-Key pro Tenant (siehe routes/admin.ts).
 */
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";
import { getDb } from "./db/index.js";
import { getBot, ensureOperatorTenant } from "./db/repo.js";
import { sha256 } from "./util/id.js";
import { botIdFromUrl, parseAllowedOrigins, isOriginAllowed } from "./util/origin.js";
import { chatRoutes } from "./routes/chat.js";
import { widgetConfigRoutes } from "./routes/widget-config.js";
import { adminRoutes } from "./routes/admin.js";
import { portalRoutes } from "./routes/portal.js";
import { stripeRoutes } from "./routes/stripe.js";
import { startCron } from "./cron.js";

export async function buildServer() {
  const app = Fastify({
    trustProxy: true, // korrekte Client-IP hinter Reverse-Proxy (Rate-Limit)
    logger: {
      level: config.isProd ? "info" : "debug",
      transport: config.isProd
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
    },
  });

  getDb();
  // Einzigen Betreiber-Zugang aus der Env sicherstellen (keine Selbstregistrierung).
  ensureOperatorTenant(config.ADMIN_EMAIL, sha256(config.adminApiKey));

  // --- CORS: pro Request entscheiden (Widget-Endpunkte gegen Bot-Whitelist). ---
  type CorsCb = (err: Error | null, opts: { origin: unknown; credentials?: boolean }) => void;
  await app.register(cors, function () {
    return function (req: FastifyRequest, cb: CorsCb) {
      const reqOrigin = req.headers.origin;
      const botId = botIdFromUrl(req.url || "");
      if (botId) {
        const bot = getBot(botId);
        if (!bot) return cb(null, { origin: false });
        const allowed = parseAllowedOrigins(bot.allowed_origins);
        const ok = isOriginAllowed(reqOrigin, allowed);
        // Bei leerer Whitelist ok=true -> Origin reflektieren (bzw. true, wenn kein Origin).
        return cb(null, { origin: ok ? reqOrigin || true : false, credentials: false });
      }
      // Nicht-Widget (Admin/Demo/Statisch): Origin reflektieren; Auth schützt Admin.
      cb(null, { origin: reqOrigin || true });
    };
  });

  // --- Rate-Limiting: Schlüssel = botId (Chat) bzw. IP (sonst). ---
  await app.register(rateLimit, {
    max: 60,
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const botId = botIdFromUrl(req.url || "");
      return botId ? `bot:${botId}` : req.ip;
    },
    // errorResponseBuilder muss statusCode setzen, sonst behandelt Fastify die
    // Rückgabe als 500. Wir setzen 429 explizit.
    errorResponseBuilder: (_req, context) => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: `Zu viele Anfragen. Bitte in ${Math.ceil(context.ttl / 1000)}s erneut versuchen.`,
    }),
  });

  // --- Datei-Uploads (Logo): hartes 2-MB-Limit, genau 1 Datei. ---
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 2 } });

  app.get("/health", async () => ({ ok: true, ts: Date.now() }));

  // Hochgeladene Kunden-Logos unter /logos/. Sicherheits-Header neutralisieren
  // evtl. in SVGs eingebettete Skripte, falls jemand die Datei-URL direkt aufruft.
  const logosDir = path.join(path.dirname(config.DATABASE_PATH), "logos");
  fs.mkdirSync(logosDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: logosDir,
    prefix: "/logos/",
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  });

  // Landing-/Onboarding-Seite unter "/".
  await app.register(fastifyStatic, {
    root: path.join(config.repoRoot, "packages", "landing", "public"),
    prefix: "/",
  });
  // Widget-Assets unter /widget/.
  await app.register(fastifyStatic, {
    root: path.join(config.repoRoot, "packages", "widget", "public"),
    prefix: "/widget/",
    decorateReply: false,
  });

  // Optional: gebautes Admin-Dashboard unter /admin/ (nur wenn dist vorhanden).
  const dashboardDist = path.join(config.repoRoot, "packages", "dashboard", "dist");
  if (fs.existsSync(path.join(dashboardDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: dashboardDist,
      prefix: "/admin/",
      decorateReply: false,
    });
    app.log.info("Admin-Dashboard unter /admin/ verfügbar.");
  }

  // Optional: gebautes Kunden-Portal unter /portal/ (nur wenn dist vorhanden).
  const portalDist = path.join(config.repoRoot, "packages", "portal", "dist");
  if (fs.existsSync(path.join(portalDist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: portalDist,
      prefix: "/portal/",
      decorateReply: false,
    });
    app.log.info("Kunden-Portal unter /portal/ verfügbar.");
  }

  await app.register(chatRoutes);
  await app.register(widgetConfigRoutes);
  await app.register(portalRoutes);
  await app.register(stripeRoutes);
  await app.register(adminRoutes);

  return app;
}

const isMain =
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href;

if (isMain) {
  const app = await buildServer();
  app
    .listen({ host: config.HOST, port: config.PORT })
    .then(() => {
      app.log.info(`SiteBot-Backend läuft auf http://${config.HOST}:${config.PORT}`);
      startCron();
    })
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}
