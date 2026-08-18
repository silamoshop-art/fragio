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
  return {
    ...PLACEHOLDER,
    ...loaded,
    bank: { ...PLACEHOLDER.bank, ...(loaded.bank ?? {}) },
  };
}

/** Ist eine echte Config hinterlegt (kein reiner Platzhalter)? */
export function operatorConfigPresent(): boolean {
  return fs.existsSync(FILE);
}
