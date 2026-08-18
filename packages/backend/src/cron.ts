/**
 * Hintergrund-Cronjobs.
 *
 * (A) Cleanup (stündlich): nicht konvertierte Trial-Bots (>30 Tage) und alte
 *     Demo-Bots (>7 Tage) endgültig löschen. Der Trial-Ablauf selbst wird
 *     zustandslos bei jedem Request geprüft (trial/state.ts).
 *
 * (B) Auto-Update / Recrawl (wöchentlich, RECRAWL_CRON): alle aktiven Bots mit
 *     Start-URL neu crawlen und den Index ersetzen. Bei Fehlschlag bleibt der
 *     alte Stand erhalten (crawlAndIndex wirft, bevor gelöscht wird) und der
 *     Fehler wird protokolliert + im Dashboard sichtbar gemacht.
 */
import cron from "node-cron";
import { config } from "./config.js";
import {
  listStaleTrialBotIds,
  listStaleSystemBotIds,
  deleteBot,
  listActiveBotsWithUrl,
  setCrawlResult,
  getBot,
  listPayingBots,
} from "./db/repo.js";
import { crawlAndIndex } from "./crawler/index.js";
import { generateInvoiceForBot } from "./billing/invoice.js";
import { runBackupOnce } from "./db/backup.js";
import { deleteExpiredChatLogs } from "./db/repo.js";

const DAY = 24 * 60 * 60 * 1000;
const TRIAL_DELETE_DAYS = 30;
const DEMO_DELETE_DAYS = 7;
const DEMO_TENANT_EMAIL = "demo@sitebot.local";

export function runCleanupOnce(): { trials: number; demos: number } {
  const staleTrials = listStaleTrialBotIds(TRIAL_DELETE_DAYS * DAY);
  for (const id of staleTrials) deleteBot(id);
  // Alte Bots des System-/Demo-Tenants (aus früheren Vorschau-Crawls) aufräumen.
  const staleDemos = listStaleSystemBotIds(DEMO_TENANT_EMAIL, DEMO_DELETE_DAYS * DAY);
  for (const id of staleDemos) deleteBot(id);

  if (staleTrials.length || staleDemos.length) {
    console.log(`🧹 Cleanup: ${staleTrials.length} Trial-Bot(s), ${staleDemos.length} Demo-Bot(s) gelöscht.`);
  }
  return { trials: staleTrials.length, demos: staleDemos.length };
}

/**
 * Alle aktiven Bots mit Start-URL neu crawlen. Sequentiell, damit nicht mehrere
 * Playwright-Instanzen gleichzeitig den Server überlasten.
 * Gibt eine Zusammenfassung zurück (auch für den manuellen/Test-Aufruf).
 */
export async function runRecrawlAll(): Promise<{ ok: number; failed: number }> {
  const bots = listActiveBotsWithUrl();
  let ok = 0,
    failed = 0;
  for (const bot of bots) {
    try {
      const fresh = getBot(bot.id);
      if (!fresh) continue;
      const res = await crawlAndIndex(fresh);
      setCrawlResult(bot.id, "ok", null);
      ok++;
      console.log(`🔄 Recrawl ok: ${bot.id} (${res.pages} Seiten, ${res.chunks} Chunks)`);
    } catch (err) {
      const msg = (err as Error).message;
      setCrawlResult(bot.id, "error", msg);
      failed++;
      // Betreiber-Hinweis (in Produktion optional an E-Mail-Hook weiterreichen).
      console.error(`⚠️  Recrawl fehlgeschlagen: ${bot.id} — ${msg} (alter Stand bleibt erhalten)`);
    }
  }
  if (bots.length) console.log(`🔄 Wöchentlicher Recrawl fertig: ${ok} ok, ${failed} fehlgeschlagen.`);
  return { ok, failed };
}

/**
 * Monatlicher Rechnungslauf: für jeden zahlenden Bot eine Rechnung für den
 * VORMONAT erzeugen. Fehler (z. B. fehlende Adresse) werden geloggt, ohne den
 * Lauf abzubrechen.
 */
export async function runMonthlyBilling(when = new Date()): Promise<{
  created: number;
  skipped: number;
  failed: { botId: string; reason: string }[];
}> {
  const bots = listPayingBots();
  let created = 0,
    skipped = 0;
  const failed: { botId: string; reason: string }[] = [];
  for (const bot of bots) {
    try {
      const r = await generateInvoiceForBot(bot, when);
      if (r.created) created++;
      else skipped++;
    } catch (err) {
      const reason = (err as Error).message;
      failed.push({ botId: bot.id, reason });
      console.error(`⚠️  Rechnung fehlgeschlagen: ${bot.id} — ${reason}`);
    }
  }
  if (bots.length) {
    console.log(`🧾 Rechnungslauf: ${created} erstellt, ${skipped} übersprungen, ${failed.length} fehlgeschlagen.`);
  }
  return { created, skipped, failed };
}

export function startCron(): void {
  // (A) stündlicher Cleanup
  cron.schedule("0 * * * *", () => {
    try {
      runCleanupOnce();
    } catch (err) {
      console.error("Cron-Cleanup-Fehler:", err);
    }
  });

  // (B) wöchentlicher Recrawl
  if (cron.validate(config.RECRAWL_CRON)) {
    cron.schedule(config.RECRAWL_CRON, () => {
      runRecrawlAll().catch((err) => console.error("Cron-Recrawl-Fehler:", err));
    });
    console.log(`⏰ Cron aktiv: Cleanup (stündlich), Recrawl (${config.RECRAWL_CRON}).`);
  } else {
    console.warn(`⚠️  Ungültiger RECRAWL_CRON: "${config.RECRAWL_CRON}" — Recrawl-Cron deaktiviert.`);
  }

  // (C) monatlicher Rechnungslauf im VORAUS: 25. des Monats, 04:00 — erstellt die
  //     Rechnung für den KOMMENDEN Monat (Vorauskasse, siehe upcomingPeriod()).
  cron.schedule("0 4 25 * *", () => {
    runMonthlyBilling().catch((err) => console.error("Cron-Billing-Fehler:", err));
  });

  // (D) tägliches DB-Backup (Audit-Punkt 2).
  if (cron.validate(config.BACKUP_CRON)) {
    cron.schedule(config.BACKUP_CRON, () => {
      try {
        const r = runBackupOnce();
        console.log(`💾 DB-Backup: ${r.file} (${(r.bytes / 1024 / 1024).toFixed(1)} MB).`);
      } catch (err) {
        console.error("Cron-Backup-Fehler:", err);
      }
    });
    console.log(`💾 Backup-Cron aktiv (${config.BACKUP_CRON}, Aufbewahrung ${config.BACKUP_KEEP_DAYS} Tage).`);
  } else {
    console.warn(`⚠️  Ungültiger BACKUP_CRON: "${config.BACKUP_CRON}" — Backup-Cron deaktiviert.`);
  }

  // (E) tägliche Löschung abgelaufener Chat-Verläufe (pro-Bot retention_days, Auftrag 2.2).
  cron.schedule("30 4 * * *", () => {
    try {
      const removed = deleteExpiredChatLogs();
      if (removed) console.log(`🧹 Chat-Verläufe (Speicherfrist): ${removed} Einträge gelöscht.`);
    } catch (err) {
      console.error("Cron-Retention-Fehler:", err);
    }
  });
}
