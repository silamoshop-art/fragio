/**
 * Zentrale, LOKALE Betreiber-Konfiguration (operator.config.json im Repo-Root).
 *
 * Enthält echte Betreiberdaten (Name, Adresse, UID, Bank, Support-Kontakt) und
 * ist in .gitignore — NIE committen. Rechnungsmodul + Support-Bereich lesen
 * ausschließlich hierüber, keine harten Daten mehr im Code.
 *
 * Fehlt die Datei, greifen klar erkennbare Platzhalter (damit nichts crasht),
 * aber ein Hinweis wird geloggt. Bei Änderungen an der Datei genügt ein Neustart
 * (bzw. reloadOperatorConfig()).
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { getSetting, setSetting } from "../db/repo.js";

// Im Admin editierbare Betreiberdaten werden in app_settings ("operator_override")
// als JSON abgelegt und ÜBER die Datei gelegt. So lassen sich Bank-/Betreiberdaten
// ändern, ohne operator.config.json auf dem Server anzufassen.
const OVERRIDE_KEY = "operator_override";

export interface OperatorBank {
  accountHolder: string;
  iban: string;
  bic: string;
  bankName: string;
}

export interface OperatorConfig {
  name: string;
  address: string; // mehrzeilig erlaubt (\n)
  uid: string; // UID-/Steuernummer
  taxNote: string; // z. B. Kleinunternehmerregelung / USt-Hinweis
  bank: OperatorBank;
  /** PayPal-Zahllink oder -E-Mail (z. B. "https://paypal.me/deinname"). Leer = aus. */
  paypal: string;
  supportEmail: string;
  supportPhone: string;
  currency: string; // z. B. "EUR"
}

const PLACEHOLDER: OperatorConfig = {
  name: "[Dein Firmenname]",
  address: "[Straße Nr.]\n[PLZ Ort]\n[Land]",
  uid: "[UID / Steuernummer]",
  taxNote: "[Steuerhinweis — z. B. Kleinunternehmer gem. §6 Abs.1 Z27 UStG]",
  bank: {
    accountHolder: "[Kontoinhaber]",
    iban: "[IBAN]",
    bic: "[BIC]",
    bankName: "[Bank]",
  },
  paypal: "",
  supportEmail: "[support@deine-domain.at]",
  supportPhone: "[+43 …]",
  currency: "EUR",
};

const FILE = path.join(config.repoRoot, "operator.config.json");
let warned = false;

/** Aktuelle Betreiber-Config (frisch von Platte, mit Platzhalter-Fallback). */
export function operatorConfig(): OperatorConfig {
  let loaded: Partial<OperatorConfig> = {};
  try {
    if (fs.existsSync(FILE)) {
      loaded = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<OperatorConfig>;
    } else if (!warned) {
      warned = true;
      console.warn(
        `⚠️  operator.config.json fehlt (${FILE}). Es werden Platzhalter genutzt — ` +
          `Rechnungen/Support zeigen keine echten Betreiberdaten. Vorlage: operator.config.example.json`,
      );
    }
  } catch (err) {
    console.error("❌ operator.config.json ist kein gültiges JSON:", (err as Error).message);
  }
  // Im Admin gespeicherte Overrides (DB) über die Datei legen.
  let override: Partial<OperatorConfig> = {};
  try {
    const raw = getSetting(OVERRIDE_KEY);
    if (raw) override = JSON.parse(raw) as Partial<OperatorConfig>;
  } catch {
    /* ignorieren — dann greift Datei/Platzhalter */
  }
  return {
    ...PLACEHOLDER,
    ...loaded,
    ...override,
    bank: { ...PLACEHOLDER.bank, ...(loaded.bank ?? {}), ...(override.bank ?? {}) },
  };
}

/** Ist eine echte Config hinterlegt (Datei ODER im Admin gespeicherte Overrides)? */
export function operatorConfigPresent(): boolean {
  if (fs.existsSync(FILE)) return true;
  try {
    return !!getSetting(OVERRIDE_KEY);
  } catch {
    return false;
  }
}

/**
 * Betreiberdaten-Override im Admin speichern (partiell, Bank wird tief gemergt).
 * Wird über die Datei gelegt und von allen Lesern (Rechnung/QR/Support) genutzt.
 */
/** Override-Form: alle Felder optional, Bank ebenfalls teilweise setzbar. */
export type OperatorOverride = Partial<Omit<OperatorConfig, "bank">> & {
  bank?: Partial<OperatorBank>;
};

export function saveOperatorOverride(patch: OperatorOverride): void {
  let current: OperatorOverride = {};
  try {
    const raw = getSetting(OVERRIDE_KEY);
    if (raw) current = JSON.parse(raw) as OperatorOverride;
  } catch {
    /* ignorieren */
  }
  const merged: OperatorOverride = {
    ...current,
    ...patch,
    bank: { ...(current.bank ?? {}), ...(patch.bank ?? {}) },
  };
  setSetting(OVERRIDE_KEY, JSON.stringify(merged));
}
