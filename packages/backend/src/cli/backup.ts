/**
 * CLI: sofortiges DB-Backup erzeugen (zusätzlich zum täglichen Cron).
 *   npm --workspace @sitebot/backend run backup:now
 *
 * Wiederherstellen: Server stoppen, die gewünschte Datei aus data/backups/ nach
 * data/sitebot.sqlite kopieren (WAL-/SHM-Dateien vorher löschen), Server starten.
 */
import { runBackupOnce, backupDir } from "../db/backup.js";
import { closeDb } from "../db/index.js";

const r = runBackupOnce();
console.log(`✅ Backup erstellt: ${r.file}`);
console.log(`   Größe: ${(r.bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`   Verzeichnis: ${backupDir()}`);
closeDb();
