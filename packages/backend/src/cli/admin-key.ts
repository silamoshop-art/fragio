/**
 * CLI: Admin-Zugang anzeigen / neu setzen / generieren — OHNE DB-Gefummel.
 *
 * Der einzige Betreiber-Zugang wird über die Umgebungsvariable ADMIN_API_KEY
 * gesteuert (siehe config.ts + ensureOperatorTenant). Dieser Helfer liest/schreibt
 * die Root-`.env` und synchronisiert den Operator-Tenant sofort.
 *
 * Nutzung:
 *   npm --workspace @sitebot/backend run admin:key                 # aktuellen Key anzeigen
 *   npm --workspace @sitebot/backend run admin:key -- --generate   # neuen sicheren Key erzeugen + speichern
 *   npm --workspace @sitebot/backend run admin:key -- --set <key>  # bestimmten Key setzen
 *   npm --workspace @sitebot/backend run admin:key -- --email <adr> # Betreiber-E-Mail ändern
 *
 * Nach --generate/--set/--email: Server neu starten, damit er die neue .env liest.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { ensureOperatorTenant } from "../db/repo.js";
import { sha256 } from "../util/id.js";
import { closeDb } from "../db/index.js";

const envPath = path.join(config.repoRoot, ".env");

/** Eine KEY=VALUE-Zeile in der .env ersetzen oder anhängen (Rest bleibt unberührt). */
function setEnvVar(key: string, value: string): void {
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    content = "";
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    if (content.length && !content.endsWith("\n")) content += "\n";
    content += line + "\n";
  }
  fs.writeFileSync(envPath, content, "utf8");
}

function readEnvVar(key: string): string | undefined {
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return undefined;
  }
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(content);
  return m ? m[1].trim() : undefined;
}

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
};

function syncTenant(email: string): void {
  // Operator-Tenant sofort auf den aktuellen (effektiven) Key + E-Mail bringen,
  // damit die laufende DB konsistent ist. Beim nächsten Serverstart passiert das
  // ohnehin automatisch (ensureOperatorTenant in server.ts).
  ensureOperatorTenant(email, sha256(config.adminApiKey));
}

const email = valueOf("--email") || config.ADMIN_EMAIL;

if (has("--generate") || has("--set")) {
  const newKey = has("--generate")
    ? "sk_admin_" + crypto.randomBytes(24).toString("base64url")
    : valueOf("--set");
  if (!newKey) {
    console.error("❌ --set benötigt einen Wert:  admin:key -- --set <dein-key>");
    process.exit(1);
  }
  setEnvVar("ADMIN_API_KEY", newKey);
  if (has("--email")) setEnvVar("ADMIN_EMAIL", email);
  // config.adminApiKey ist noch der ALTE Wert (Env wurde beim Import gelesen);
  // Tenant deshalb explizit mit dem NEUEN Key synchronisieren.
  ensureOperatorTenant(email, sha256(newKey));

  console.log("✅ Neuer Admin-Zugang gespeichert in", envPath);
  console.log("   ────────────────────────────────────────────");
  console.log("   ADMIN_API_KEY :", newKey);
  console.log("   ADMIN_EMAIL   :", email);
  console.log("   ────────────────────────────────────────────");
  console.log("   ➜ Server neu starten, dann im Dashboard (/admin/) diesen Key eingeben.");
  console.log("   ⚠️  Bewahre den Key sicher auf (z. B. Passwortmanager).");
} else if (has("--email")) {
  setEnvVar("ADMIN_EMAIL", email);
  syncTenant(email);
  console.log("✅ Betreiber-E-Mail aktualisiert:", email, "(", envPath, ")");
} else {
  // Nur anzeigen (Recovery-Fall: „Ich habe meinen Key verloren").
  const fromEnv = readEnvVar("ADMIN_API_KEY");
  console.log("Aktueller Admin-Zugang");
  console.log("──────────────────────");
  console.log("Betreiber-E-Mail :", config.ADMIN_EMAIL);
  if (fromEnv) {
    console.log("ADMIN_API_KEY    :", fromEnv, "  (aus .env)");
    console.log("\n➜ Damit meldest du dich im Dashboard (/admin/) an.");
  } else {
    console.log("ADMIN_API_KEY    : (nicht in .env gesetzt)");
    console.log("Effektiver Key   :", config.adminApiKey, "  (Dev-Fallback)");
    console.log(
      "\n➜ Für Produktion einen festen Key setzen:\n" +
        "    npm --workspace @sitebot/backend run admin:key -- --generate",
    );
  }
}

closeDb();
