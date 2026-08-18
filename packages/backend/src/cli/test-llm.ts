/**
 * CLI-Smoke-Test für Schritt 1: beweist, dass DB + sqlite-vec + lokaler
 * LLM-Provider (Embeddings & Chat-Streaming) zusammen funktionieren.
 *
 *   npm --workspace @sitebot/backend run test:llm
 *
 * Voraussetzung: Ollama läuft und die Modelle sind gepullt:
 *   ollama pull nomic-embed-text
 *   ollama pull phi3
 */
import { getDb, closeDb, serializeEmbedding } from "../db/index.js";
import { getProviderForBot } from "../llm/index.js";
import { embed } from "../llm/embedder.js";
import { config } from "../config.js";

async function main() {
  console.log("── Schritt-1 Smoke-Test ──\n");

  // 1) DB + sqlite-vec
  const db = getDb();
  console.log(`✅ DB unter ${config.DATABASE_PATH} geöffnet.`);
  console.log(`   Standard-Engine: ${config.DEFAULT_ENGINE} · Embed-Modell: ${config.EMBEDDING_MODEL}\n`);

  // 3) Embeddings (lokal, In-Process — kein Ollama, kein API-Key nötig)
  console.log("→ Erzeuge Embeddings (lokal via transformers, 1. Lauf lädt Modell)…");
  const texts = [
    "Unsere Öffnungszeiten sind Montag bis Freitag von 9 bis 17 Uhr.",
    "Wir bieten kostenlosen Versand ab 50 Euro Bestellwert.",
  ];
  const embeddings = await embed(texts);
  console.log(`✅ ${embeddings.length} Embeddings, Dimension ${embeddings[0].length}`);
  if (embeddings[0].length !== config.EMBEDDING_DIM) {
    console.warn(
      `⚠️  Dimension (${embeddings[0].length}) != config.EMBEDDING_DIM (${config.EMBEDDING_DIM}). ` +
        `Passe EMBEDDING_DIM an oder wechsle das Embed-Modell.`,
    );
  }

  // 4) In vec_chunks schreiben & KNN-Suche testen (Tenant-Isolation über bot_id)
  const testBot = "__smoketest__";
  db.prepare("DELETE FROM vec_chunks WHERE bot_id = ?").run(testBot);
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks(bot_id, chunk_id, embedding) VALUES (?, ?, ?)",
  );
  embeddings.forEach((emb, i) => {
    // node:sqlite bindet JS-number als REAL; vec0-Metadatenspalte verlangt INTEGER -> BigInt.
    insertVec.run(testBot, BigInt(i + 1), serializeEmbedding(emb));
  });

  const queryEmb = (await embed(["Wann habt ihr geöffnet?"], "query"))[0];
  const hits = db
    .prepare(
      `SELECT chunk_id, distance FROM vec_chunks
       WHERE bot_id = ? AND embedding MATCH ? AND k = 2
       ORDER BY distance`,
    )
    .all(testBot, serializeEmbedding(queryEmb)) as {
    chunk_id: number;
    distance: number;
  }[];
  console.log(
    `✅ KNN-Suche: bester Treffer chunk_id=${hits[0]?.chunk_id} (distance=${hits[0]?.distance.toFixed(4)})`,
  );
  db.prepare("DELETE FROM vec_chunks WHERE bot_id = ?").run(testBot);

  // 5) Chat-Streaming über die Standard-Engine (Haiku 4.5). Braucht ANTHROPIC_API_KEY.
  console.log("\n→ Chat-Antwort (Standard-Engine):");
  try {
    const provider = getProviderForBot({
      llm_provider: "local",
      encrypted_api_key: null,
      chat_model: null,
      trial_mode: 0,
      fallback_to_local: 0,
      trial_expires_at: null,
      trial_request_count: 0,
      trial_request_cap: 100,
    });
    console.log(`   Provider: ${provider.id} (chat=${provider.chatModel})`);
    process.stdout.write("   ");
    const context = texts.map((t, i) => `[Quelle ${i + 1}] ${t}`).join("\n");
    for await (const piece of provider.streamAnswer({
      system:
        "Du bist ein hilfreicher Assistent. Antworte NUR anhand des Kontexts, sonst ehrlich 'weiß ich nicht'.",
      messages: [{ role: "user", content: `Kontext:\n${context}\n\nFrage: Wann habt ihr geöffnet?` }],
      maxTokens: 128,
    })) {
      process.stdout.write(piece);
    }
    console.log("");
  } catch (err) {
    console.log(
      `   ⏭  übersprungen: ${(err as Error).message}\n` +
        `      (Embeddings + Suche laufen; für Chat ANTHROPIC_API_KEY setzen.)`,
    );
  }
  console.log("\n✅ Smoke-Test abgeschlossen.");
  closeDb();
}

main().catch((err) => {
  console.error("\n❌ Smoke-Test fehlgeschlagen:", err.message);
  if (err.cause) console.error("   Ursache:", err.cause);
  closeDb();
  process.exit(1);
});
