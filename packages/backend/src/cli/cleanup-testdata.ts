/**
 * CLI: Test-/Demo-Daten aufräumen für einen sauberen Echtstart.
 *
 *   npm --workspace @sitebot/backend run cleanup:testdata          # Vorschau (dry-run)
 *   npm --workspace @sitebot/backend run cleanup:testdata -- --yes # tatsächlich löschen
 *
 * Behält NUR den Operator-Tenant (dein Login). Löscht alle Bots (inkl. Vektor-Index,
 * Chunks, Chat-Logs, Rechnungen, Portal-Logins, Consent-Events via deleteBot) und alle
 * Nicht-Operator-Tenants. Setzt die Rechnungsnummern zurück (nächste echte = JAHR-001)
 * und entfernt verwaiste Test-Rechnungs-PDFs. Vorher wird IMMER ein Backup erzeugt.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb, closeDb } from "../db/index.js";
import { deleteBot, OPERATOR_TENANT_ID } from "../db/repo.js";
import { runBackupOnce } from "../db/backup.js";
import { config } from "../config.js";

const apply = process.argv.includes("--yes");
const db = getDb();

const bots = db.prepare("SELECT id, name, tenant_id FROM bots").all() as {
  id: string;
  name: string;
  tenant_id: string;
}[];
const tenants = db.prepare("SELECT id, email FROM tenants").all() as { id: string; email: string }[];
const otherTenants = tenants.filter((t) => t.id !== OPERATOR_TENANT_ID);

console.log(`Gefunden: ${bots.length} Bot(s), ${tenants.length} Tenant(s).`);
console.log(`Wird GELÖSCHT: alle ${bots.length} Bot(s) + ${otherTenants.length} Nicht-Operator-Tenant(s).`);
console.log(`Wird BEHALTEN: Operator-Tenant "${OPERATOR_TENANT_ID}" (Login).`);

if (!apply) {
  console.log("\n(DRY-RUN) — nichts gelöscht. Mit `-- --yes` ausführen, um wirklich aufzuräumen.");
  closeDb();
  process.exit(0);
}

// Sicherheits-Backup zuerst.
const b = runBackupOnce();
console.log(`\n💾 Sicherheits-Backup: ${b.file} (${(b.bytes / 1024 / 1024).toFixed(1)} MB)`);

let deletedBots = 0;
for (const bot of bots) {
  deleteBot(bot.id); // clearBotKnowledge (vec_chunks) + Cascade (chunks/logs/invoices/…)
  deletedBots++;
}
const delTenants = db
  .prepare(`DELETE FROM tenants WHERE id != ?`)
  .run(OPERATOR_TENANT_ID);
db.exec("DELETE FROM invoice_counters"); // Rechnungsnummern für Echtstart zurücksetzen

// Verwaiste Test-Rechnungs-PDFs entfernen.
const invDir = path.join(config.repoRoot, "data", "invoices");
let pdfDeleted = 0;
try {
  for (const f of fs.readdirSync(invDir)) {
    if (f.endsWith(".pdf")) {
      fs.unlinkSync(path.join(invDir, f));
      pdfDeleted++;
    }
  }
} catch {
  /* Verzeichnis evtl. nicht vorhanden */
}

const rest = db.prepare("SELECT id, email FROM tenants").all() as { id: string; email: string }[];
const remainingBots = (db.prepare("SELECT COUNT(*) c FROM bots").get() as { c: number }).c;
const remainingInv = (db.prepare("SELECT COUNT(*) c FROM invoices").get() as { c: number }).c;

console.log(`\n✅ Gelöscht: ${deletedBots} Bot(s), ${Number(delTenants.changes)} Tenant(s), ${pdfDeleted} Rechnungs-PDF(s).`);
console.log(`Verbleibend: ${rest.length} Tenant(s) [${rest.map((t) => t.email).join(", ")}], ${remainingBots} Bot(s), ${remainingInv} Rechnung(en).`);
console.log("Rechnungsnummern zurückgesetzt — nächste echte Rechnung: " + new Date().getFullYear() + "-001.");
closeDb();
