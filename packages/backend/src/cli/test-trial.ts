/**
 * CLI-Test für Schritt 9 (Trial-Logik ohne echten Anthropic-Key):
 *   npm --workspace @sitebot/backend run test:trial
 *
 * Prüft: trialStatus-Übergänge, Kontingent-Zählung bei Chat, weiche Abstufung
 * bei Ablauf/Erschöpfung, und den Cron-Cleanup (Löschung alter Trial-/Demo-Bots).
 */
import { getDb, closeDb } from "../db/index.js";
import {
  createTenant,
  createBot,
  getBot,
  clearBotKnowledge,
  incrementTrialCount,
  getOrCreateSystemTenant,
} from "../db/repo.js";
import { crawlAndIndex } from "../crawler/index.js";
import { answerQuestion } from "../rag/answer.js";
import { trialStatus, isTrialActive } from "../trial/state.js";
import { runCleanupOnce } from "../cron.js";
import { randomId, newApiKey, sha256 } from "../util/id.js";

const EMAIL = "trialtest@sitebot.local";
let pass = 0,
  fail = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  cond ? pass++ : fail++;
}

async function main() {
  console.log("── Trial-Test ──\n");
  const db = getDb();

  // Aufräumen.
  const old = db
    .prepare("SELECT b.id FROM bots b JOIN tenants t ON t.id=b.tenant_id WHERE t.email=?")
    .all(EMAIL) as { id: string }[];
  for (const b of old) clearBotKnowledge(b.id);
  db.prepare("DELETE FROM tenants WHERE email=?").run(EMAIL);

  const tenantId = randomId();
  createTenant(tenantId, EMAIL, sha256(newApiKey()));

  // 1) trialStatus-Übergänge (reine Logik)
  console.log("1) trialStatus:");
  const base = { trial_mode: 1, trial_expires_at: Date.now() + 1000, trial_request_count: 0, trial_request_cap: 100 };
  check('kein Trial -> "none"', trialStatus({ ...base, trial_mode: 0 }) === "none");
  check('aktiv -> "active"', trialStatus(base) === "active");
  check('abgelaufen -> "expired"', trialStatus({ ...base, trial_expires_at: Date.now() - 1 }) === "expired");
  check('erschöpft -> "exhausted"', trialStatus({ ...base, trial_request_count: 100 }) === "exhausted");

  // 2) Kontingent-Zählung bei echtem Chat (Provider fällt ohne Key auf lokal zurück,
  //    aber isTrialActive=true -> Zähler wird belastet).
  console.log("\n2) Kontingent-Zählung bei Chat:");
  const trialBot = createBot({
    tenantId,
    name: "Trial-Bot",
    startUrl: "https://example.com",
    maxPages: 2,
    trialMode: true,
    trialDays: 7,
    trialRequestCap: 3,
  });
  check("frisch angelegt -> aktiv", isTrialActive(getBot(trialBot.id)!));
  await crawlAndIndex(getBot(trialBot.id)!);
  // Eine beantwortbare Frage stellen -> Stream konsumieren.
  for await (const _ of answerQuestion(getBot(trialBot.id)!, "What is this domain for?")) void _;
  const after1 = getBot(trialBot.id)!;
  check(`Zähler nach 1 Chat = 1 (ist ${after1.trial_request_count})`, after1.trial_request_count === 1);

  // 3) Kontingent erschöpfen -> weiche Abstufung (nicht mehr aktiv)
  console.log("\n3) Kontingent erschöpfen:");
  incrementTrialCount(trialBot.id);
  incrementTrialCount(trialBot.id); // jetzt 3 >= cap 3
  const exhausted = getBot(trialBot.id)!;
  check(`erschöpft (count=${exhausted.trial_request_count}, cap=${exhausted.trial_request_cap})`, !isTrialActive(exhausted));
  check('trialStatus = "exhausted"', trialStatus(exhausted) === "exhausted");
  // Weiterer Chat darf den Zähler NICHT weiter erhöhen (Trial-Key wird nicht genutzt).
  for await (const _ of answerQuestion(getBot(trialBot.id)!, "What is this domain for?")) void _;
  check("Zähler bleibt bei 3 (kein Trial-Key mehr)", getBot(trialBot.id)!.trial_request_count === 3);

  // 4) Cron-Cleanup
  console.log("\n4) Cron-Cleanup:");
  // Alten, nicht konvertierten Trial-Bot simulieren (created_at vor 31 Tagen).
  const oldTrial = createBot({ tenantId, name: "Alt-Trial", trialMode: true, trialDays: 7 });
  db.prepare("UPDATE bots SET created_at = ? WHERE id = ?").run(
    BigInt(Date.now() - 31 * 24 * 60 * 60 * 1000),
    oldTrial.id,
  );
  // Alten Demo-Bot simulieren (geteilter System-Tenant, vor 8 Tagen).
  const demoTenant = getOrCreateSystemTenant("demo@sitebot.local");
  const oldDemo = createBot({ tenantId: demoTenant, name: "Alt-Demo" });
  db.prepare("UPDATE bots SET created_at = ? WHERE id = ?").run(
    BigInt(Date.now() - 8 * 24 * 60 * 60 * 1000),
    oldDemo.id,
  );

  const res = runCleanupOnce();
  check(`alter Trial-Bot gelöscht (${res.trials} Trial(s))`, getBot(oldTrial.id) === undefined);
  check(`alter Demo-Bot gelöscht (${res.demos} Demo(s))`, getBot(oldDemo.id) === undefined);
  check("junger Trial-Bot bleibt", getBot(trialBot.id) !== undefined);

  console.log(`\n${fail === 0 ? "✅ Alle" : "⚠️  " + pass + "/" + (pass + fail)} Checks bestanden.`);
  closeDb();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ Trial-Test fehlgeschlagen:", err.message);
  if (err.cause) console.error("   Ursache:", err.cause);
  closeDb();
  process.exit(1);
});
