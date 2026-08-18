/**
 * Konsistentes SQLite-Backup (Audit-Punkt 2).
 *
 * Nutzt `VACUUM INTO`, das eine transaktional saubere Kopie der gesamten DB in eine
 * neue Datei schreibt (inkl. WAL-Inhalt) — anders als ein reines File-Copy, das bei
 * aktivem WAL inkonsistent sein kann. Alte Backups werden nach BACKUP_KEEP_DAYS gelöscht.
 */
import fs from "node:fs";
import path from "node:path";
import { getDb } from "./index.js";
import { config } from "../config.js";

export function backupDir(): string {
  return path.join(path.dirname(config.DATABASE_PATH), "backups");
}

/** Einen Snapshot erzeugen. Gibt den Pfad der Backup-Datei zurück. */
export function runBackupOnce(now = new Date()): { file: string; bytes: number } {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });

  const ts =
    now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    "-" +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0") +
    String(now.getSeconds()).padStart(2, "0");
  const file = path.join(dir, `sitebot-${ts}.sqlite`);

  // VACUUM INTO benötigt einen String-Literal-Pfad; Backslashes für SQLite escapen
  // und einfache Anführungszeichen verdoppeln.
  const escaped = file.replace(/\\/g, "/").replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);

  const bytes = fs.statSync(file).size;
  pruneOldBackups(now);
  return { file, bytes };
}

/** Backups älter als BACKUP_KEEP_DAYS löschen. */
export function pruneOldBackups(now = new Date()): number {
  const dir = backupDir();
  let removed = 0;
  const cutoff = now.getTime() - config.BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!/^sitebot-.*\.sqlite$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
