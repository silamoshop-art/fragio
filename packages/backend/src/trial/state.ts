/**
 * Trial-Zustandslogik (Schritt 9).
 *
 * Ein Trial-Bot nutzt den zentral hinterlegten Trial-API-Key (Anthropic), damit
 * Interessenten echte KI-Qualität testen können — begrenzt durch:
 *   - Zeit: trial_expires_at (createdAt + Trial-Tage, Standard 7)
 *   - Kontingent: trial_request_count < trial_request_cap (Standard 100)
 *
 * Der Ablauf wird bei JEDEM Request geprüft (kein destruktives Umschalten nötig):
 * Ist der Trial abgelaufen/erschöpft, liefert der Provider-Factory den lokalen
 * Gratis-Modus zurück (weiche Abstufung statt harter Sperre). Das endgültige
 * Löschen nicht-konvertierter Trial-Bots übernimmt der Cronjob (cron.ts).
 */
export interface TrialFields {
  trial_mode: number;
  trial_expires_at: number | null;
  trial_request_count: number;
  trial_request_cap: number;
}

export type TrialStatus = "none" | "active" | "expired" | "exhausted";

export function trialStatus(bot: TrialFields): TrialStatus {
  if (!bot.trial_mode) return "none";
  if (bot.trial_expires_at !== null && Date.now() >= bot.trial_expires_at) return "expired";
  if (bot.trial_request_count >= bot.trial_request_cap) return "exhausted";
  return "active";
}

/** Nur wenn aktiv wird der Trial-Key verwendet und das Kontingent belastet. */
export function isTrialActive(bot: TrialFields): boolean {
  return trialStatus(bot) === "active";
}
