/**
 * Management-API für das Admin-Dashboard.
 *
 * Auth (Grundversion — Härtung/Rate-Limit in Schritt 8): Der Tenant authentifiziert
 * sich mit seinem Management-API-Key im Header `Authorization: Bearer <key>`.
 * Gespeichert wird nur der SHA-256-Hash. Jede Bot-Operation prüft die Zugehörigkeit
 * zum Tenant (getBotForTenant) -> keine Cross-Tenant-Zugriffe.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  getTenantByApiKeyHash,
  getBotForTenant,
  listBotsByTenant,
  createBot,
  updateBot,
  deleteBot,
  getBotAnalytics,
  countChunks,
  getBotUsage,
  setCrawlResult,
  getTenant,
  updateTenantBilling,
  listInvoicesForBot,
  getInvoiceForTenant,
  upsertBotUser,
  getBotUserForBot,
  listPlanChangesForTenant,
  listPlanChangeRequestsForTenant,
  getPlanChangeRequestForTenant,
  markPlanChangeRequestDone,
  listOpenInvoicesForTenant,
  markInvoicePaid,
  markInvoiceReminderSent,
  consentStats,
  listChatLogs,
  deleteChatLogsByIpHash,
  INVOICE_DUE_DAYS,
  type BotRow,
  type InvoiceRow,
  type OpenInvoiceRow,
} from "../db/repo.js";
import { sendEmail, verifySmtp } from "../notify/email.js";
import { operatorConfig } from "../config/operator.js";
import { applyPlanToBot, stripeEnabled, recomputeBotPrice } from "../payments/stripe.js";
import { planName, getPricing, savePricing, DEFAULT_PRICING, type Pricing } from "../billing/plans.js";
import { crawlAndIndex } from "../crawler/index.js";
import {
  generateInvoiceForBot,
  generateExtraInvoice,
  prorateCents,
  InvoiceDataError,
} from "../billing/invoice.js";
import { snippetFor, previewUrlFor, backendBase } from "../util/embed.js";
import { hashPassword } from "../crypto/password.js";
import fs from "node:fs";
import { encryptSecret } from "../crypto/secrets.js";
import { checkPublicHttpUrl } from "../util/url-guard.js";
import { newApiKey, sha256 } from "../util/id.js";
import type { ProviderId } from "../llm/types.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant?: { id: string; email: string };
  }
}

/** Bot ohne Geheimnisse fürs Dashboard aufbereiten. */
function presentBot(bot: BotRow) {
  let branding: Record<string, unknown> = {};
  try {
    branding = JSON.parse(bot.branding);
  } catch {
    /* ignore */
  }
  return {
    id: bot.id,
    name: bot.name,
    status: bot.status,
    llmProvider: bot.llm_provider,
    hasApiKey: !!bot.encrypted_api_key,
    chatModel: bot.chat_model,
    fallbackToLocal: !!bot.fallback_to_local,
    crawlStartUrl: bot.crawl_start_url,
    crawlMaxPages: bot.crawl_max_pages,
    lastCrawledAt: bot.last_crawled_at,
    allowedOrigins: safeArray(bot.allowed_origins),
    branding,
    trialMode: !!bot.trial_mode,
    trialExpiresAt: bot.trial_expires_at,
    trialRequestCount: bot.trial_request_count,
    trialRequestCap: bot.trial_request_cap,
    chunkCount: countChunks(bot.id),
    createdAt: bot.created_at,
    // Kostenkontrolle / Verbrauch (Package A/B)
    maxInputChars: bot.max_input_chars,
    maxAnswerTokens: bot.max_answer_tokens,
    monthlyQuota: bot.monthly_quota,
    limitMessage: bot.limit_message,
    usage: getBotUsage(bot),
    // Auto-Update-Log (Package C)
    lastCrawlStatus: bot.last_crawl_status,
    lastCrawlError: bot.last_crawl_error,
    // Billing (Package D)
    plan: bot.plan,
    priceCents: bot.price_cents,
    basePriceCents: bot.base_price_cents,
    discountType: bot.discount_type,
    discountValue: bot.discount_value,
    isPaying: !!bot.is_paying,
    autoSendInvoice: !!bot.auto_send_invoice,
    addonLogo: !!bot.addon_logo,
    addonName: !!bot.addon_name,
    // DSGVO/AI-Act: pro Bot editierbarer Datenschutztext (Consent-Popup, Section C).
    privacyText: bot.privacy_text,
    // Rechnungsdaten DES KUNDEN — pro Bot eigenständig.
    customerName: bot.customer_name,
    customerAddress: bot.customer_address,
    customerEmail: bot.customer_email,
    customerVat: bot.customer_vat,
    // Anonymer Consent-Nachweis (Anzahl + letzte Zustimmung).
    consent: consentStats(bot.id),
    retentionDays: bot.retention_days,
    previewUrl: previewUrlFor(bot.id),
    portalUrl: `${backendBase()}/portal/`,
    portalUser: getBotUserForBot(bot.id)?.email ?? null,
  };
}

function presentInvoice(inv: InvoiceRow) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    period: inv.period,
    periodLabel: inv.period_label,
    amountCents: inv.amount_cents,
    currency: inv.currency,
    plan: inv.plan,
    sent: !!inv.sent,
    createdAt: inv.created_at,
  };
}

function presentOpenInvoice(inv: OpenInvoiceRow) {
  const due = inv.due_date ?? inv.created_at + INVOICE_DUE_DAYS * 24 * 60 * 60 * 1000;
  return {
    id: inv.id,
    invoiceNumber: inv.invoice_number,
    botId: inv.bot_id,
    botName: inv.bot_name,
    customerName: inv.billing_name,
    customerEmail: inv.billing_email,
    periodLabel: inv.period_label,
    amountCents: inv.amount_cents,
    currency: inv.currency,
    dueDate: due,
    overdue: Date.now() > due,
    reminderSentAt: inv.reminder_sent_at,
  };
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}


export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Keine Selbstregistrierung: Es gibt genau EINEN Betreiber-Zugang, der beim
  // Serverstart aus ADMIN_API_KEY/ADMIN_EMAIL angelegt wird (siehe server.ts).

  // --- Auth-preHandler für alle folgenden Routen. ---
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["authorization"] || "";
    const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(header) ? header[0] : header);
    if (!m) return reply.code(401).send({ error: "Kein API-Key." });
    const tenant = getTenantByApiKeyHash(sha256(m[1].trim()));
    if (!tenant) return reply.code(401).send({ error: "Ungültiger API-Key." });
    request.tenant = tenant;
  };

  app.register(async (secured) => {
    secured.addHook("preHandler", authenticate);

    secured.get("/api/admin/me", async (request) => ({
      tenantId: request.tenant!.id,
      email: request.tenant!.email,
      stripeEnabled: stripeEnabled(),
    }));

    // --- Preis-Einstellungen (global konfigurierbar) ---
    secured.get("/api/admin/pricing", async () => getPricing());

    secured.patch("/api/admin/pricing", async (request, reply) => {
      const planSchema = z.object({
        limit: z.number().int().min(1),
        setupMonthlyCents: z.number().int().min(0),
        commitMonthlyCents: z.number().int().min(0),
      });
      const schema = z.object({
        setupFeeCents: z.number().int().min(0),
        commitMonths: z.number().int().min(0).max(60),
        plans: z.object({ starter: planSchema, business: planSchema, pro: planSchema }),
        addons: z.object({
          logoCents: z.number().int().min(0),
          nameCents: z.number().int().min(0),
          bundleCents: z.number().int().min(0),
        }),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Preisstruktur." });
      savePricing(parsed.data as Pricing);
      return getPricing();
    });

    secured.get("/api/admin/pricing/defaults", async () => DEFAULT_PRICING);

    // Offene/erledigte Tarif-Anfragen aus dem Portal.
    secured.get("/api/admin/plan-change-requests", async (request) =>
      listPlanChangeRequestsForTenant(request.tenant!.id).map((r) => ({
        id: r.id,
        botId: r.bot_id,
        botName: r.bot_name,
        planId: r.plan_id,
        planName: planName(r.plan_id),
        variant: r.variant,
        kind: r.kind,
        monthlyCents: r.monthly_cents,
        setupCents: r.setup_cents,
        commitmentMonths: r.commitment_months,
        status: r.status,
        createdAt: r.created_at,
      })),
    );

    // Anfrage freischalten: Tarif am Bot setzen (Kontingent/Preis) + Anfrage erledigt.
    secured.post<{ Params: { id: string } }>(
      "/api/admin/plan-change-requests/:id/resolve",
      async (request, reply) => {
        const id = Number(request.params.id);
        const req = Number.isFinite(id)
          ? getPlanChangeRequestForTenant(id, request.tenant!.id)
          : undefined;
        if (!req) return reply.code(404).send({ error: "Anfrage nicht gefunden." });
        if (req.status === "done") return { ok: true, alreadyDone: true };

        if (req.kind === "plan") {
          applyPlanToBot(req.bot_id, req.plan_id, req.monthly_cents);
          // Einrichtungsgebühr der Variante vormerken (nur auf der 1. Rechnung berechnet).
          updateBot(req.bot_id, { setup_fee_due_cents: req.setup_cents });
        } else {
          // Branding-Zusatzoption freischalten: Flag(s) setzen + Monatspreis aufschlagen.
          const bot = getBotForTenant(req.bot_id, request.tenant!.id)!;
          updateBot(req.bot_id, {
            addon_logo: req.kind === "addon_logo" || req.kind === "addon_bundle" ? 1 : bot.addon_logo,
            addon_name: req.kind === "addon_name" || req.kind === "addon_bundle" ? 1 : bot.addon_name,
            base_price_cents: bot.base_price_cents + req.monthly_cents,
            is_paying: 1,
          });
          recomputeBotPrice(req.bot_id);
        }
        markPlanChangeRequestDone(req.id);
        return { ok: true };
      },
    );

    // Letzte Tarifwechsel der Kunden (für die nächste Rechnung im Blick behalten).
    secured.get("/api/admin/plan-changes", async (request) =>
      listPlanChangesForTenant(request.tenant!.id).map((c) => ({
        botId: c.bot_id,
        botName: c.bot_name,
        fromPlan: c.from_plan,
        toPlan: c.to_plan,
        priceCents: c.price_cents,
        createdAt: c.created_at,
      })),
    );

    // --- Rechnungsdaten des Kunden (Firmenadresse für Rechnungen) ---
    secured.get("/api/admin/billing", async (request) => {
      const t = getTenant(request.tenant!.id);
      return {
        billingName: t?.billing_name ?? "",
        billingAddress: t?.billing_address ?? "",
        billingEmail: t?.billing_email ?? "",
        vatId: t?.vat_id ?? "",
      };
    });

    secured.patch("/api/admin/billing", async (request, reply) => {
      const schema = z.object({
        billingName: z.string().max(120).optional(),
        billingAddress: z.string().max(400).optional(),
        billingEmail: z.string().email().or(z.literal("")).optional(),
        vatId: z.string().max(40).optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Eingabe." });
      const d = parsed.data;
      updateTenantBilling(request.tenant!.id, {
        billing_name: d.billingName,
        billing_address: d.billingAddress,
        billing_email: d.billingEmail,
        vat_id: d.vatId,
      });
      return { ok: true };
    });

    secured.get("/api/admin/bots", async (request) =>
      listBotsByTenant(request.tenant!.id).map(presentBot),
    );

    secured.post("/api/admin/bots", async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1).max(80),
        startUrl: z.string().max(2048).optional(),
        maxPages: z.number().int().min(1).max(200).optional(),
        allowedOrigins: z.array(z.string()).optional(),
        trialMode: z.boolean().optional(), // 7-Tage-Trial mit zentralem Key
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Eingabe." });
      if (parsed.data.startUrl) {
        const check = checkPublicHttpUrl(parsed.data.startUrl);
        if (!check.ok) return reply.code(400).send({ error: check.reason });
      }
      const bot = createBot({
        tenantId: request.tenant!.id,
        name: parsed.data.name,
        startUrl: parsed.data.startUrl,
        maxPages: parsed.data.maxPages,
        allowedOrigins: parsed.data.allowedOrigins,
        trialMode: parsed.data.trialMode,
        trialDays: parsed.data.trialMode ? 7 : undefined,
      });
      return reply.code(201).send(presentBot(bot));
    });

    // Bot laden + Ownership prüfen (Helper).
    const loadOwned = (request: FastifyRequest, reply: FastifyReply): BotRow | null => {
      const { id } = request.params as { id: string };
      const bot = getBotForTenant(id, request.tenant!.id);
      if (!bot) {
        reply.code(404).send({ error: "Bot nicht gefunden." });
        return null;
      }
      return bot;
    };

    secured.get("/api/admin/bots/:id", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      return presentBot(bot);
    });

    secured.get("/api/admin/bots/:id/snippet", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      return { snippet: snippetFor(bot.id) };
    });

    secured.get("/api/admin/bots/:id/analytics", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      return getBotAnalytics(bot.id);
    });

    // Chat-Log-Detailansicht (jüngste zuerst) — zeigt den IP-Hash, nicht die echte IP.
    secured.get("/api/admin/bots/:id/chat-logs", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      return listChatLogs(bot.id, 100).map((l) => ({
        id: l.id,
        question: l.question,
        answered: !!l.answered,
        ipHash: l.ip_hash,
        createdAt: l.created_at,
      }));
    });

    // Alle Anfragen desselben Absenders (gleicher IP-Hash) löschen (Art. 17 DSGVO).
    secured.post("/api/admin/bots/:id/chat-logs/delete-by-sender", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      const parsed = z.object({ ipHash: z.string().min(16).max(128) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "ipHash fehlt." });
      const deleted = deleteChatLogsByIpHash(bot.id, parsed.data.ipHash);
      return { deleted };
    });

    // Kunden-Portal-Login für diesen Bot anlegen/zurücksetzen. Passwort optional —
    // ohne Angabe wird eines generiert und EINMALIG zurückgegeben.
    secured.post("/api/admin/bots/:id/portal-user", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      const schema = z.object({
        email: z.string().email(),
        password: z.string().min(8).max(200).optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Gültige E-Mail nötig (Passwort min. 8 Zeichen)." });
      }
      const email = parsed.data.email.toLowerCase().trim();
      const password = parsed.data.password || newApiKey().slice(3, 15); // 12-stellig
      try {
        upsertBotUser(bot.id, email, hashPassword(password));
      } catch {
        return reply.code(409).send({ error: "Diese E-Mail ist bereits für einen anderen Bot vergeben." });
      }
      return {
        email,
        // Passwort nur zurückgeben, wenn wir es generiert haben (einmalig anzeigen).
        password: parsed.data.password ? undefined : password,
        portalUrl: `${backendBase()}/portal/`,
      };
    });

    secured.patch("/api/admin/bots/:id", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      const schema = z.object({
        name: z.string().min(1).max(80).optional(),
        llmProvider: z.enum(["local", "anthropic", "openai", "ollama"]).optional(),
        apiKey: z.string().optional(), // Klartext -> wird verschlüsselt
        chatModel: z.string().max(120).nullable().optional(),
        fallbackToLocal: z.boolean().optional(),
        allowedOrigins: z.array(z.string()).optional(),
        branding: z
          .object({
            botName: z.string().max(80).optional(),
            primaryColor: z.string().max(20).optional(),
            greeting: z.string().max(300).optional(),
            logoUrl: z.string().max(2048).optional(),
          })
          .optional(),
        crawlStartUrl: z.string().max(2048).optional(),
        crawlMaxPages: z.number().int().min(1).max(200).optional(),
        // Kostenkontrolle (Package B)
        maxInputChars: z.number().int().min(20).max(4000).optional(),
        maxAnswerTokens: z.number().int().min(50).max(2000).optional(),
        monthlyQuota: z.number().int().min(0).max(1_000_000).optional(),
        limitMessage: z.string().max(500).nullable().optional(),
        // Status aktiv/pausiert (Quick-Fix)
        status: z.enum(["active", "paused"]).optional(),
        // Billing (Package D)
        plan: z.string().max(80).nullable().optional(),
        priceCents: z.number().int().min(0).max(10_000_000).optional(),
        isPaying: z.boolean().optional(),
        autoSendInvoice: z.boolean().optional(),
        // Pro-Kunde-Rabatt (überschreibt nur diesen Bot)
        discountType: z.enum(["percent", "fixed"]).nullable().optional(),
        discountValue: z.number().int().min(0).max(10_000_000).optional(),
        // DSGVO/AI-Act: Datenschutztext fürs Consent-Popup (Section C)
        privacyText: z.string().max(20_000).nullable().optional(),
        // Rechnungsdaten DES KUNDEN — pro Bot eigenständig (Prompt 9 #1).
        customerName: z.string().max(200).nullable().optional(),
        customerAddress: z.string().max(500).nullable().optional(),
        customerEmail: z.union([z.string().email(), z.literal(""), z.null()]).optional(),
        customerVat: z.string().max(80).nullable().optional(),
        // Genau EINE erlaubte Domain pro Bot (Prompt 9 #2: kein Multi-Domain mehr).
        domain: z.string().max(255).optional(),
        // Speicherdauer der Chat-Verläufe (Auftrag 2.2).
        retentionDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Ungültige Eingabe." });
      const d = parsed.data;

      if (d.crawlStartUrl) {
        const check = checkPublicHttpUrl(d.crawlStartUrl);
        if (!check.ok) return reply.code(400).send({ error: check.reason });
      }

      updateBot(bot.id, {
        name: d.name,
        llm_provider: d.llmProvider as ProviderId | undefined,
        // Key nur setzen, wenn nicht-leer übergeben. Leerstring "" -> Key entfernen.
        encrypted_api_key:
          d.apiKey === undefined ? undefined : d.apiKey ? encryptSecret(d.apiKey) : null,
        chat_model: d.chatModel,
        fallback_to_local: d.fallbackToLocal === undefined ? undefined : d.fallbackToLocal ? 1 : 0,
        // Single-Domain (Prompt 9 #2): `domain` gewinnt; intern weiterhin als Array
        // gespeichert (CORS-Logik unverändert), aber mit maximal EINEM Eintrag.
        allowed_origins:
          d.domain !== undefined
            ? JSON.stringify(d.domain.trim() ? [d.domain.trim()] : [])
            : d.allowedOrigins
              ? JSON.stringify(d.allowedOrigins.slice(0, 1))
              : undefined,
        branding: d.branding ? JSON.stringify(d.branding) : undefined,
        crawl_start_url: d.crawlStartUrl,
        crawl_max_pages: d.crawlMaxPages,
        max_input_chars: d.maxInputChars,
        max_answer_tokens: d.maxAnswerTokens,
        monthly_quota: d.monthlyQuota,
        limit_message: d.limitMessage,
        status: d.status,
        plan: d.plan,
        price_cents: d.priceCents,
        is_paying: d.isPaying === undefined ? undefined : d.isPaying ? 1 : 0,
        auto_send_invoice: d.autoSendInvoice === undefined ? undefined : d.autoSendInvoice ? 1 : 0,
        discount_type: d.discountType,
        discount_value: d.discountValue,
        privacy_text: d.privacyText,
        customer_name: d.customerName,
        customer_address: d.customerAddress,
        customer_email: d.customerEmail === "" ? null : d.customerEmail,
        customer_vat: d.customerVat,
        retention_days: d.retentionDays,
      });
      // Rabatt-/Preisänderung -> effektiven Preis aus Basispreis neu berechnen.
      if (d.discountType !== undefined || d.discountValue !== undefined) {
        recomputeBotPrice(bot.id);
      }
      return presentBot(getBotForTenant(bot.id, request.tenant!.id)!);
    });

    secured.delete("/api/admin/bots/:id", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      deleteBot(bot.id);
      return { ok: true };
    });

    // --- Rechnungen: Historie, manuelle Erzeugung, PDF-Download ---
    secured.get("/api/admin/bots/:id/invoices", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      return listInvoicesForBot(bot.id).map(presentInvoice);
    });

    // Monats-Abo-Rechnung im Voraus erzeugen (kommender Monat, Vorauskasse).
    secured.post("/api/admin/bots/:id/invoice", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      try {
        const r = await generateInvoiceForBot(bot);
        return { created: r.created, invoice: r.invoice ? presentInvoice(r.invoice) : null };
      } catch (err) {
        if (err instanceof InvoiceDataError) {
          return reply.code(422).send({ error: err.message });
        }
        request.log.error(err);
        return reply.code(500).send({ error: "Rechnung fehlgeschlagen." });
      }
    });

    // Proration-Vorschlag (anteiliger Betrag für den Rest des laufenden Monats).
    secured.get("/api/admin/bots/:id/proration", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      const p = prorateCents(bot.price_cents, new Date());
      return { cents: p.cents, remainingDays: p.remainingDays, daysInMonth: p.daysInMonth };
    });

    // Freie Zusatzrechnung (Betrag, Beschreibung, Zeitraum) — z. B. Proration bei
    // Tarifwechsel oder Sonderposten. Gleiche lückenlose Nummer wie Monatsrechnungen.
    secured.post("/api/admin/bots/:id/extra-invoice", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      const schema = z.object({
        amountCents: z.number().int().positive().max(100_000_000),
        description: z.string().min(1).max(300),
        periodLabel: z.string().max(120).optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Betrag + Beschreibung erforderlich." });
      try {
        const r = await generateExtraInvoice(bot, {
          amountCents: parsed.data.amountCents,
          description: parsed.data.description,
          periodLabel: parsed.data.periodLabel || "Einzelrechnung",
        });
        return { created: r.created, invoice: r.invoice ? presentInvoice(r.invoice) : null };
      } catch (err) {
        if (err instanceof InvoiceDataError) return reply.code(422).send({ error: err.message });
        request.log.error(err);
        return reply.code(500).send({ error: "Zusatzrechnung fehlgeschlagen." });
      }
    });

    // PDF-Download (Ownership über tenant_id geprüft).
    secured.get<{ Params: { invoiceId: string } }>(
      "/api/admin/invoices/:invoiceId/pdf",
      async (request, reply) => {
        const id = Number(request.params.invoiceId);
        const inv = Number.isFinite(id)
          ? getInvoiceForTenant(id, request.tenant!.id)
          : undefined;
        if (!inv) return reply.code(404).send({ error: "Rechnung nicht gefunden." });
        if (!fs.existsSync(inv.pdf_path)) {
          return reply.code(410).send({ error: "PDF-Datei nicht mehr vorhanden." });
        }
        reply
          .header("Content-Type", "application/pdf")
          .header("Content-Disposition", `inline; filename="Rechnung-${inv.invoice_number}.pdf"`);
        return reply.send(fs.createReadStream(inv.pdf_path));
      },
    );

    // SMTP-Verbindung testen (Produktions-Check: kommen Rechnungen/Mahnungen raus?).
    secured.get("/api/admin/smtp-test", async () => verifySmtp());

    // Echte Test-Mail verschicken (optional mit einer bestehenden Rechnung als PDF-Anhang),
    // um die End-to-End-Zustellung zu bestätigen.
    secured.post("/api/admin/smtp-test-send", async (request, reply) => {
      const schema = z.object({
        to: z.string().email(),
        invoiceId: z.number().int().positive().optional(),
      });
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Gültige Empfänger-E-Mail nötig." });

      const smtp = await verifySmtp();
      if (!smtp.configured) {
        return reply.code(422).send({
          error: "SMTP nicht konfiguriert — SMTP_HOST/SMTP_USER/SMTP_PASS in der .env setzen und Server neu starten.",
        });
      }
      if (!smtp.ok) {
        return reply.code(502).send({ error: `SMTP-Verbindung fehlgeschlagen: ${smtp.error}` });
      }

      let attachments: { filename: string; path: string }[] = [];
      let invoiceNote = "";
      if (parsed.data.invoiceId) {
        const inv = getInvoiceForTenant(parsed.data.invoiceId, request.tenant!.id);
        if (inv && fs.existsSync(inv.pdf_path)) {
          attachments = [{ filename: `Rechnung-${inv.invoice_number}.pdf`, path: inv.pdf_path }];
          invoiceNote = ` Im Anhang findest du beispielhaft die Rechnung ${inv.invoice_number}.`;
        }
      }

      const op = operatorConfig();
      const body = [
        `Das ist eine Test-E-Mail von deinem SiteBot-System.`,
        ``,
        `Wenn du diese Nachricht liest, funktioniert der SMTP-Versand korrekt —` +
          ` Rechnungen, Mahnungen und Support-Weiterleitungen erreichen ab jetzt echte Empfänger.` +
          invoiceNote,
        ``,
        `Absender laut Konfiguration: ${op.name}`,
        `Support: ${op.supportEmail || "(nicht gesetzt)"}`,
      ].join("\n");

      try {
        await sendEmail(parsed.data.to, `SMTP-Test von ${op.name}`, body, attachments);
      } catch (e) {
        return reply.code(502).send({ error: `Versand fehlgeschlagen: ${(e as Error).message}` });
      }
      return { ok: true, sentTo: parsed.data.to, attached: attachments.length > 0 };
    });

    // ── Offene Zahlungen (Section D) ──────────────────────────────────────────
    // Liste aller unbezahlten Rechnungen mit Betrag + Fälligkeit.
    secured.get("/api/admin/open-payments", async (request) =>
      listOpenInvoicesForTenant(request.tenant!.id).map(presentOpenInvoice),
    );

    // Rechnung als bezahlt markieren.
    secured.post<{ Params: { invoiceId: string } }>(
      "/api/admin/invoices/:invoiceId/paid",
      async (request, reply) => {
        const id = Number(request.params.invoiceId);
        if (!Number.isFinite(id)) return reply.code(400).send({ error: "Ungültige ID." });
        const ok = markInvoicePaid(id, request.tenant!.id);
        if (!ok) return reply.code(404).send({ error: "Rechnung nicht gefunden." });
        return { ok: true };
      },
    );

    // Mahnung senden: E-Mail an Kunden mit Betrag + Rechnung als Anhang.
    // Absender/Betreiberdaten stammen aus operator.config.json.
    secured.post<{ Params: { invoiceId: string } }>(
      "/api/admin/invoices/:invoiceId/reminder",
      async (request, reply) => {
        const id = Number(request.params.invoiceId);
        const inv = Number.isFinite(id)
          ? getInvoiceForTenant(id, request.tenant!.id)
          : undefined;
        if (!inv) return reply.code(404).send({ error: "Rechnung nicht gefunden." });
        if (inv.paid) return reply.code(409).send({ error: "Rechnung ist bereits bezahlt." });

        const invBot = getBotForTenant(inv.bot_id, request.tenant!.id);
        if (!invBot?.customer_email) {
          return reply.code(422).send({ error: "Keine Rechnungs-E-Mail des Kunden für diesen Bot hinterlegt." });
        }

        const op = operatorConfig();
        const amount = (inv.amount_cents / 100).toFixed(2).replace(".", ",") + " " + inv.currency;
        const attachments =
          inv.pdf_path && fs.existsSync(inv.pdf_path)
            ? [{ filename: `Rechnung-${inv.invoice_number}.pdf`, path: inv.pdf_path }]
            : [];

        const body = [
          `Sehr geehrte Damen und Herren,`,
          ``,
          `zu unserer Rechnung ${inv.invoice_number} (Leistungszeitraum ${inv.period_label}) über ` +
            `${amount} konnten wir bislang keinen Zahlungseingang feststellen.`,
          ``,
          `Wir bitten Sie, den offenen Betrag zeitnah zu begleichen. Die Rechnung finden Sie im Anhang.`,
          ``,
          `Zahlbar auf folgendes Konto:`,
          `Kontoinhaber: ${op.bank.accountHolder}`,
          `IBAN: ${op.bank.iban}   BIC: ${op.bank.bic}`,
          `Verwendungszweck: ${inv.invoice_number}`,
          ``,
          `Sollte sich Ihre Zahlung mit dieser Mahnung überschnitten haben, betrachten Sie dieses ` +
            `Schreiben bitte als gegenstandslos.`,
          ``,
          `Mit freundlichen Grüßen`,
          op.name,
          op.supportEmail ? `Rückfragen: ${op.supportEmail}` : "",
        ]
          .filter((l) => l !== undefined)
          .join("\n");

        await sendEmail(
          invBot.customer_email,
          `Zahlungserinnerung zu Rechnung ${inv.invoice_number}`,
          body,
          attachments,
        );
        markInvoiceReminderSent(inv.id);
        return { ok: true, sentTo: invBot.customer_email, attached: attachments.length > 0 };
      },
    );

    // Recrawl mit SSE-Fortschritt.
    secured.post("/api/admin/bots/:id/recrawl", async (request, reply) => {
      const bot = loadOwned(request, reply);
      if (!bot) return;
      if (!bot.crawl_start_url) {
        return reply.code(400).send({ error: "Bot hat keine Start-URL." });
      }
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      try {
        const result = await crawlAndIndex(bot, (p) => send("progress", p));
        setCrawlResult(bot.id, "ok", null);
        send("ready", result);
      } catch (err) {
        const msg = (err as Error).message;
        setCrawlResult(bot.id, "error", msg);
        request.log.error(err);
        send("error", { message: "Recrawl fehlgeschlagen: " + msg });
      } finally {
        res.end();
      }
    });
  });
}
