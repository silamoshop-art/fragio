/**
 * CLI-Test für Package D (Rechnungstool):
 *   npm --workspace @sitebot/backend run test:billing
 *
 * Prüft: fortlaufende Nummer (n, n+1), PDF-Datei erzeugt, korrekter Betrag,
 * Idempotenz (kein Doppel pro Zeitraum), Fehler bei fehlender Rechnungsadresse.
 */
import fs from "node:fs";
import { getDb, closeDb } from "../db/index.js";
import {
  createTenant,
  createBot,
  updateBot,
  getBot,
  clearBotKnowledge,
} from "../db/repo.js";
import { generateInvoiceForBot, InvoiceDataError, upcomingPeriod } from "../billing/invoice.js";

// Kundenrechnungsdaten liegen jetzt PRO BOT (nicht mehr am Tenant).
const CUST = {
  customer_name: "Muster GmbH",
  customer_address: "Musterstraße 1\n4020 Linz",
  customer_email: "kunde@muster.at",
  customer_vat: "ATU12345678",
};
import { randomId, newApiKey, sha256 } from "../util/id.js";

const EMAIL = "billingtest@sitebot.local";
let pass = 0,
  fail = 0;
const check = (l: string, c: boolean) => {
  console.log(`  ${c ? "✅" : "❌"} ${l}`);
  c ? pass++ : fail++;
};
const seqOf = (num: string) => Number(num.split("-")[1]);

async function main() {
  console.log("── Rechnungs-Test ──\n");
  const db = getDb();
  const old = db
    .prepare("SELECT b.id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.email=?")
    .all(EMAIL) as { id: string }[];
  for (const b of old) clearBotKnowledge(b.id);
  db.prepare("DELETE FROM tenants WHERE email=?").run(EMAIL);

  const tenantId = randomId();
  createTenant(tenantId, EMAIL, sha256(newApiKey()));

  // 1) Fehlende Kundendaten -> InvoiceDataError, keine Nummer verbraucht.
  console.log("1) Fehlende Rechnungsdaten des Kunden:");
  const botNoAddr = createBot({ tenantId, name: "Ohne-Adresse" });
  updateBot(botNoAddr.id, { is_paying: 1, price_cents: 4900, plan: "Starter" });
  let threw = false;
  try {
    await generateInvoiceForBot(getBot(botNoAddr.id)!);
  } catch (e) {
    threw = e instanceof InvoiceDataError;
  }
  check("wirft InvoiceDataError (keine Rechnung mit Lücken)", threw);

  // 2) Zwei zahlende Bots mit EIGENEN Kundendaten -> fortlaufende Nummern.
  console.log("\n2) Fortlaufende Nummern + PDF:");
  const botA = createBot({ tenantId, name: "Bot-A" });
  updateBot(botA.id, { is_paying: 1, price_cents: 4900, plan: "Starter", ...CUST });
  const botB = createBot({ tenantId, name: "Bot-B" });
  updateBot(botB.id, { is_paying: 1, price_cents: 12900, plan: "Business", ...CUST });

  const rA = await generateInvoiceForBot(getBot(botA.id)!);
  const rB = await generateInvoiceForBot(getBot(botB.id)!);
  check(`A erstellt (${rA.invoice?.invoice_number})`, rA.created && !!rA.invoice);
  check(`B erstellt (${rB.invoice?.invoice_number})`, rB.created && !!rB.invoice);
  check(
    `Nummern fortlaufend (${rA.invoice!.invoice_number} -> ${rB.invoice!.invoice_number})`,
    seqOf(rB.invoice!.invoice_number) === seqOf(rA.invoice!.invoice_number) + 1,
  );
  check(`Betrag A = 4900 Cent`, rA.invoice!.amount_cents === 4900);
  check("PDF A existiert & > 0 Bytes", fs.existsSync(rA.invoice!.pdf_path) && fs.statSync(rA.invoice!.pdf_path).size > 0);
  check(`Zeitraum = kommender Monat / Vorauskasse (${upcomingPeriod().period})`, rA.invoice!.period === upcomingPeriod().period);

  // 3) Idempotenz: nochmal für Bot-A -> kein Doppel.
  console.log("\n3) Idempotenz:");
  const rA2 = await generateInvoiceForBot(getBot(botA.id)!);
  check("zweiter Lauf erstellt KEINE neue Rechnung", !rA2.created);
  check("liefert dieselbe Nummer zurück", rA2.invoice!.invoice_number === rA.invoice!.invoice_number);

  console.log(`\n${fail === 0 ? "✅ Alle" : "⚠️  " + pass + "/" + (pass + fail)} Checks bestanden.`);
  closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Test fehlgeschlagen:", err.message);
  closeDb();
  process.exit(1);
});
