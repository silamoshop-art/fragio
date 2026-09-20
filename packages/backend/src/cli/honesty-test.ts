/**
 * Ehrlichkeitstest (Anforderungskatalog D/E): misst, wie zuverlässig ein Bot bei
 * NICHT beantwortbaren „Fangfragen" ehrlich passt — statt zu halluzinieren — und
 * beantwortbare Fragen tatsächlich beantwortet.
 *
 * Aufruf:
 *   npx tsx packages/backend/src/cli/honesty-test.ts <botId> <testset.json> [report.json]
 *
 * Testset-Format (JSON-Array):
 *   [{ "question": "…", "expect": "answer" | "refuse" }, …]
 *   - expect="refuse": Frage lässt sich NICHT aus der Website beantworten. Ehrlich
 *     ist eine Absage ("weiß ich nicht"). Eine erfundene Antwort = Halluzination.
 *   - expect="answer": Frage steht in den Inhalten; eine Absage wäre ein Fehler.
 *
 * Ergebnis: pro Frage Soll/Ist, Gesamt-Ehrlichkeitsquote + Halluzinationsquote.
 * Reproduzierbar und dokumentierbar — Grundlage für die öffentliche Testseite.
 */
import fs from "node:fs";
import { getBot } from "../db/repo.js";
import { answerQuestion, type AnswerMeta } from "../rag/answer.js";

interface TestItem {
  question: string;
  expect: "answer" | "refuse";
}

async function runOne(botId: string, item: TestItem) {
  const bot = getBot(botId)!;
  let meta: AnswerMeta | null = null;
  let full = "";
  // storeContent:false -> der Test schreibt keine Chat-Logs (zählt nicht mit).
  for await (const piece of answerQuestion(bot, item.question, (m) => (meta = m), {
    storeContent: false,
  })) {
    full += piece;
  }
  const answered = meta ? (meta as AnswerMeta).answered && !(meta as AnswerMeta).escalated : false;
  const correct = item.expect === "answer" ? answered : !answered;
  return { question: item.question, expect: item.expect, answered, correct, answer: full };
}

async function main() {
  const [botId, testPath, reportPath] = process.argv.slice(2);
  if (!botId || !testPath) {
    console.error("Aufruf: honesty-test.ts <botId> <testset.json> [report.json]");
    process.exit(1);
  }
  const bot = getBot(botId);
  if (!bot) {
    console.error(`Bot ${botId} nicht gefunden.`);
    process.exit(1);
  }
  const items = JSON.parse(fs.readFileSync(testPath, "utf8")) as TestItem[];

  const results = [];
  for (const item of items) {
    const r = await runOne(botId, item);
    results.push(r);
    const mark = r.correct ? "OK " : "XX ";
    console.log(`${mark}[soll: ${item.expect}, ist: ${r.answered ? "answer" : "refuse"}] ${item.question}`);
  }

  const total = results.length;
  const correct = results.filter((r) => r.correct).length;
  // Halluzination = "refuse"-Frage wurde beantwortet (erfundene Antwort).
  const refuseItems = results.filter((r) => r.expect === "refuse");
  const hallucinated = refuseItems.filter((r) => r.answered).length;

  const summary = {
    botId,
    ranAt: new Date().toISOString(),
    total,
    correct,
    honestyRate: total ? +((correct / total) * 100).toFixed(1) : 0,
    refuseTotal: refuseItems.length,
    hallucinated,
    hallucinationRate: refuseItems.length ? +((hallucinated / refuseItems.length) * 100).toFixed(1) : 0,
  };

  console.log("\n=== Ergebnis ===");
  console.log(`Ehrlichkeitsquote: ${summary.honestyRate}% (${correct}/${total} korrekt)`);
  console.log(`Halluzinationsquote: ${summary.hallucinationRate}% (${hallucinated}/${refuseItems.length} Fangfragen falsch beantwortet)`);

  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ summary, results }, null, 2));
    console.log(`\nBericht geschrieben: ${reportPath}`);
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
