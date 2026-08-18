/**
 * CLI-Test für Schritt 2 (Crawler isoliert):
 *   npm --workspace @sitebot/backend run test:crawl -- <url> [maxPages]
 *
 * Legt einen Test-Tenant + Test-Bot an, crawlt die URL, indexiert lokal und
 * führt eine Beispiel-KNN-Suche aus. Gibt am Ende die botId aus (für Schritt 3).
 *
 * Default-URL: https://example.com (klein, schnell, robots-freundlich).
 */
import { getDb, closeDb } from "../db/index.js";
import {
  createTenant,
  createBot,
  clearBotKnowledge,
  countChunks,
  searchChunks,
} from "../db/repo.js";
import { crawlAndIndex } from "../crawler/index.js";
import { embed } from "../llm/embedder.js";
import { randomId, newApiKey, sha256 } from "../util/id.js";

const TEST_EMAIL = "crawltest@sitebot.local";

async function main() {
  const url = process.argv[2] || "https://example.com";
  const maxPages = Number(process.argv[3] || 5);
  console.log(`── Crawler-Test ──\n  URL: ${url}\n  maxPages: ${maxPages}\n`);

  const db = getDb();

  // Alte Test-Daten aufräumen (vec_chunks explizit, da kein FK-Cascade).
  const oldBots = db
    .prepare(
      "SELECT b.id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.email=?",
    )
    .all(TEST_EMAIL) as { id: string }[];
  for (const b of oldBots) clearBotKnowledge(b.id);
  db.prepare("DELETE FROM tenants WHERE email=?").run(TEST_EMAIL);

  // Frischen Test-Tenant + Bot anlegen.
  const tenantId = randomId();
  createTenant(tenantId, TEST_EMAIL, sha256(newApiKey()));
  const bot = createBot({
    tenantId,
    name: "Crawl-Test-Bot",
    startUrl: url,
    maxPages,
  });
  console.log(`  botId: ${bot.id}\n`);

  // Crawlen + indexieren mit Fortschritt.
  const result = await crawlAndIndex(bot, (p) => {
    if (p.phase === "crawling") {
      process.stdout.write(`\r  🕷  crawle… ${p.fetched} Seiten (Queue ${p.queued})   `);
    } else if (p.phase === "indexing") {
      process.stdout.write(`\r  📚 indexiere… ${p.chunks} Chunks               `);
    }
  });
  console.log(
    `\n\n✅ Fertig: ${result.pages} Seiten indexiert, ${result.chunks} Chunks (DB: ${countChunks(bot.id)}).`,
  );

  // Beispiel-KNN-Suche.
  const q = "What is this website about?";
  const [qEmb] = await embed([q], "query");
  const hits = searchChunks(bot.id, qEmb, 3);
  console.log(`\n🔎 Suche: "${q}"`);
  hits.forEach((h, i) => {
    const snippet = h.content.replace(/\n/g, " ").slice(0, 120);
    console.log(`  ${i + 1}. [d=${h.distance.toFixed(3)}] ${snippet}…`);
  });

  console.log(`\n➡  Für Schritt 3 (Chat) botId verwenden: ${bot.id}`);
  closeDb();
}

main().catch((err) => {
  console.error("\n❌ Crawler-Test fehlgeschlagen:", err.message);
  if (err.cause) console.error("   Ursache:", err.cause);
  closeDb();
  process.exit(1);
});
