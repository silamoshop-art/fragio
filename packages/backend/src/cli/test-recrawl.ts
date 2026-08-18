/**
 * CLI-Test für Package C (Auto-Update):
 *   npm --workspace @sitebot/backend run test:recrawl
 *
 * Prüft: erfolgreicher (Re)Crawl setzt Status "ok"; fehlgeschlagener Crawl
 * (nicht erreichbare URL) BEHÄLT den alten Index und setzt Status "error".
 */
import { getDb, closeDb } from "../db/index.js";
import {
  createTenant,
  createBot,
  updateBot,
  getBot,
  countChunks,
  setCrawlResult,
  clearBotKnowledge,
} from "../db/repo.js";
import { crawlAndIndex } from "../crawler/index.js";
import { randomId, newApiKey, sha256 } from "../util/id.js";

const EMAIL = "recrawltest@sitebot.local";
let pass = 0,
  fail = 0;
const check = (l: string, c: boolean) => {
  console.log(`  ${c ? "✅" : "❌"} ${l}`);
  c ? pass++ : fail++;
};

async function main() {
  console.log("── Recrawl-Test ──\n");
  const db = getDb();
  const old = db
    .prepare("SELECT b.id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.email=?")
    .all(EMAIL) as { id: string }[];
  for (const b of old) clearBotKnowledge(b.id);
  db.prepare("DELETE FROM tenants WHERE email=?").run(EMAIL);
  const tenantId = randomId();
  createTenant(tenantId, EMAIL, sha256(newApiKey()));

  // 1) Erfolgreicher Crawl -> Status ok, Chunks vorhanden.
  console.log("1) Erfolgreicher Crawl (example.com):");
  const bot = createBot({ tenantId, name: "Recrawl-Bot", startUrl: "https://example.com", maxPages: 2 });
  try {
    await crawlAndIndex(getBot(bot.id)!);
    setCrawlResult(bot.id, "ok", null);
  } catch (e) {
    setCrawlResult(bot.id, "error", (e as Error).message);
  }
  const afterOk = getBot(bot.id)!;
  const chunksAfterOk = countChunks(bot.id);
  check(`Status = "ok" (ist "${afterOk.last_crawl_status}")`, afterOk.last_crawl_status === "ok");
  check(`Chunks vorhanden (${chunksAfterOk})`, chunksAfterOk > 0);

  // 2) Fehlgeschlagener Recrawl (nicht erreichbare Domain) -> alter Index bleibt.
  console.log("\n2) Fehlgeschlagener Recrawl (unerreichbare URL):");
  updateBot(bot.id, { crawl_start_url: "https://this-domain-does-not-exist-xyz-12345.invalid" });
  let threw = false;
  try {
    await crawlAndIndex(getBot(bot.id)!);
    setCrawlResult(bot.id, "ok", null);
  } catch (e) {
    threw = true;
    setCrawlResult(bot.id, "error", (e as Error).message);
  }
  const afterFail = getBot(bot.id)!;
  const chunksAfterFail = countChunks(bot.id);
  check("Crawl hat geworfen (Fehler erkannt)", threw);
  check(`Status = "error" (ist "${afterFail.last_crawl_status}")`, afterFail.last_crawl_status === "error");
  check(`Alter Index BLEIBT erhalten (${chunksAfterFail} Chunks, vorher ${chunksAfterOk})`, chunksAfterFail === chunksAfterOk && chunksAfterFail > 0);
  check("Fehlermeldung gespeichert", !!afterFail.last_crawl_error);

  console.log(`\n${fail === 0 ? "✅ Alle" : "⚠️  " + pass + "/" + (pass + fail)} Checks bestanden.`);
  closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("❌ Test fehlgeschlagen:", err.message);
  closeDb();
  process.exit(1);
});
