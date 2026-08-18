/**
 * CLI-Test für Package A (Kostenkontrolle):
 *   npm --workspace @sitebot/backend run test:quota
 *
 * Prüft: pro-Bot max_input_chars, Monatskontingent (Verbrauch/Blockade),
 * Reset bei Monatswechsel.
 */
import { getDb, closeDb } from "../db/index.js";
import {
  createTenant,
  createBot,
  updateBot,
  getBot,
  consumeQuota,
  getBotUsage,
  clearBotKnowledge,
} from "../db/repo.js";
import { randomId, newApiKey, sha256 } from "../util/id.js";

const EMAIL = "quotatest@sitebot.local";
let pass = 0,
  fail = 0;
const check = (l: string, c: boolean) => {
  console.log(`  ${c ? "✅" : "❌"} ${l}`);
  c ? pass++ : fail++;
};

function main() {
  console.log("── Kontingent-Test ──\n");
  const db = getDb();
  const old = db
    .prepare("SELECT b.id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.email=?")
    .all(EMAIL) as { id: string }[];
  for (const b of old) clearBotKnowledge(b.id);
  db.prepare("DELETE FROM tenants WHERE email=?").run(EMAIL);

  const tenantId = randomId();
  createTenant(tenantId, EMAIL, sha256(newApiKey()));
  const bot = createBot({ tenantId, name: "Quota-Bot" });

  // Defaults
  console.log("1) Defaults:");
  const fresh = getBot(bot.id)!;
  check(`max_input_chars = 500 (ist ${fresh.max_input_chars})`, fresh.max_input_chars === 500);
  check(`max_answer_tokens = 250 (ist ${fresh.max_answer_tokens})`, fresh.max_answer_tokens === 250);
  check(`monthly_quota = 500 (ist ${fresh.monthly_quota})`, fresh.monthly_quota === 500);

  // Kontingent auf 3 setzen
  console.log("\n2) Kontingent = 3, viermal verbrauchen:");
  updateBot(bot.id, { monthly_quota: 3 });
  const r1 = consumeQuota(bot.id);
  const r2 = consumeQuota(bot.id);
  const r3 = consumeQuota(bot.id);
  const r4 = consumeQuota(bot.id);
  check(`1. erlaubt (used=${r1.used})`, r1.allowed && r1.used === 1);
  check(`2. erlaubt (used=${r2.used})`, r2.allowed && r2.used === 2);
  check(`3. erlaubt (used=${r3.used})`, r3.allowed && r3.used === 3);
  check(`4. BLOCKIERT (used=${r4.used}/${r4.quota})`, !r4.allowed);

  // Verbrauchsanzeige
  console.log("\n3) Verbrauchsanzeige:");
  const usage = getBotUsage(getBot(bot.id)!);
  check(`getBotUsage: used=3, quota=3`, usage.used === 3 && usage.quota === 3);

  // Monatswechsel-Reset simulieren (usage_period auf Vormonat setzen)
  console.log("\n4) Monatswechsel-Reset:");
  db.prepare("UPDATE bots SET usage_period = '2000-01' WHERE id = ?").run(bot.id);
  const afterReset = consumeQuota(bot.id);
  check(`nach Monatswechsel wieder erlaubt (used=${afterReset.used})`, afterReset.allowed && afterReset.used === 1);

  console.log(`\n${fail === 0 ? "✅ Alle" : "⚠️  " + pass + "/" + (pass + fail)} Checks bestanden.`);
  closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error("❌ Test fehlgeschlagen:", (err as Error).message);
  closeDb();
  process.exit(1);
}
