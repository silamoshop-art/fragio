/**
 * DSGVO-/EU-AI-Act-Texte fürs Consent-Popup & die Datenschutz-Unterseite.
 *
 * defaultPrivacyText(): Vorlage mit allen Pflichtpunkten (Verantwortlicher, Zweck,
 * Rechtsgrundlage Einwilligung, verarbeitete Daten, Speicherdauer, Drittland-
 * übermittlung an Anthropic/USA, Widerrufsrecht). Pro Bot editierbar (bots.privacy_text).
 */

/** Kurzer Hinweistext fürs Consent-Popup (AI-Act-Transparenz + zwei Verarbeitungsmodi). */
export const CONSENT_NOTICE =
  "Dies ist ein KI-Chatbot. Zur Beantwortung werden deine Nachrichten an einen " +
  "KI-Dienstleister (Anthropic, USA) übermittelt — das ist für die Nutzung des Chats " +
  "notwendig. Zusätzlich kannst du erlauben, dass wir den Gesprächsverlauf zur " +
  "Verbesserung und für Statistiken speichern. Details in der Datenschutzerklärung.";

export function defaultPrivacyText(companyName: string, retentionDays = 90): string {
  const company = companyName || "[Verantwortlicher / Firma]";
  return [
    `Datenschutzerklärung zum KI-Chatbot`,
    ``,
    `Dieser Chat wird durch ein KI-System (KI-Chatbot) bereitgestellt. Kennzeichnung gemäß ` +
      `EU-KI-Verordnung (AI-Act): Sie kommunizieren mit einem automatisierten System, nicht mit ` +
      `einem Menschen. Nachstehend informieren wir Sie gemäß Art. 13 DSGVO über die Verarbeitung ` +
      `Ihrer Daten. Wir unterscheiden dabei zwischen der notwendigen Verarbeitung zur ` +
      `Bereitstellung des Chats und der optionalen Speicherung des Gesprächsverlaufs für unsere ` +
      `eigenen Statistiken.`,
    ``,
    `1. Verantwortlicher`,
    `Verantwortlich für die Datenverarbeitung ist ${company}. Die vollständigen Kontaktdaten ` +
      `(Anschrift, E-Mail, Telefon) finden Sie im Impressum dieser Website.`,
    ``,
    `2. Zweck der Verarbeitung`,
    `Notwendig: Beantwortung Ihrer Fragen zu den Inhalten dieser Website durch einen KI-gestützten ` +
      `Chat-Assistenten (Weiterleitung Ihrer Nachricht an den KI-Dienstleister zur Antwort). ` +
      `Optional (nur mit Ihrer Zustimmung): Speicherung des Gesprächsverlaufs bei uns, um häufige ` +
      `und unbeantwortete Fragen auszuwerten und den Service zu verbessern.`,
    ``,
    `3. Rechtsgrundlage`,
    `Für die notwendige Verarbeitung (Nutzung des Chats, Weiterleitung zur Antwortgenerierung): ` +
      `Vertragserfüllung bzw. Durchführung vorvertraglicher Maßnahmen (Art. 6 Abs. 1 lit. b DSGVO) ` +
      `sowie unser berechtigtes Interesse an einem funktionierenden Support-Angebot ` +
      `(Art. 6 Abs. 1 lit. f DSGVO). Für die optionale Speicherung des Gesprächsverlaufs zu ` +
      `Statistik-/Verbesserungszwecken: Ihre Einwilligung (Art. 6 Abs. 1 lit. a DSGVO), die Sie ` +
      `im Chat-Fenster erteilen und jederzeit widerrufen können. Wählen Sie „Nur notwendige ` +
      `Verarbeitung", findet keine solche Speicherung statt.`,
    ``,
    `4. Welche Daten werden verarbeitet`,
    `Der von Ihnen eingegebene Nachrichtentext und die generierte Antwort sowie technisch ` +
      `notwendige Angaben. Zur Missbrauchsprävention und zur Umsetzung von Löschanfragen ` +
      `speichern wir zusätzlich eine gehashte (nicht rückrechenbare) Form Ihrer IP-Adresse ` +
      `(Rechtsgrundlage: berechtigtes Interesse, Art. 6 Abs. 1 lit. f DSGVO). Bitte geben Sie keine ` +
      `besonderen Kategorien personenbezogener Daten (z. B. Gesundheitsdaten) oder unnötige ` +
      `personenbezogene Daten ein.`,
    ``,
    `5. Speicherdauer`,
    `Bei „Nur notwendige Verarbeitung" wird der Gesprächsinhalt bei uns nicht gespeichert. Haben ` +
      `Sie der Speicherung zugestimmt, werden die Gesprächsverläufe nach ${retentionDays} Tagen ` +
      `automatisch gelöscht.`,
    ``,
    `6. Empfänger / Drittlandübermittlung`,
    `Zur Antwortgenerierung werden Ihre Nachrichten an unseren Auftragsverarbeiter Anthropic ` +
      `(Anbieter des KI-Modells „Claude") mit Sitz in den USA übermittelt. Die USA gelten als ` +
      `Drittland ohne generelles Angemessenheitsniveau; die Übermittlung erfolgt auf Grundlage ` +
      `geeigneter Garantien (Standardvertragsklauseln). Diese Weiterleitung ist zur Erbringung ` +
      `des Chat-Dienstes erforderlich.`,
    ``,
    `7. Ihre Rechte`,
    `Ihnen stehen zu: Auskunft (Art. 15), Berichtigung (Art. 16), Löschung (Art. 17), ` +
      `Einschränkung der Verarbeitung (Art. 18), Datenübertragbarkeit (Art. 20) und Widerspruch ` +
      `(Art. 21 DSGVO). Zudem haben Sie das Recht auf Beschwerde bei einer Datenschutz-` +
      `Aufsichtsbehörde (Art. 77 DSGVO).`,
    ``,
    `8. Widerruf der Einwilligung`,
    `Sie können Ihre Einwilligung in die optionale Speicherung jederzeit mit Wirkung für die ` +
      `Zukunft widerrufen, indem Sie die im Browser gespeicherte Zustimmung zurücksetzen. Die ` +
      `Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt unberührt.`,
  ].join("\n");
}
