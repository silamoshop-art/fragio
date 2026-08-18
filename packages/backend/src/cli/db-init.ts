/**
 * CLI: Datenbank initialisieren / Schema anwenden.
 *   npm --workspace @sitebot/backend run db:init
 */
import { getDb, closeDb } from "../db/index.js";
import { config } from "../config.js";

const db = getDb();
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
  .all() as { name: string }[];

console.log(`✅ DB initialisiert: ${config.DATABASE_PATH}`);
console.log("   Tabellen:", tables.map((t) => t.name).join(", "));
closeDb();
