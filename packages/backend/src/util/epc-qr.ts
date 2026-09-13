/**
 * EPC-QR-Code („Giro-Code", EPC069-12) für SEPA-Überweisungen.
 *
 * Banking-Apps scannen diesen Code und füllen Empfänger, IBAN, Betrag und
 * Verwendungszweck automatisch aus — der Kunde muss nichts abtippen.
 * Der Code wird nur erzeugt, wenn eine plausible IBAN vorliegt (sonst null,
 * z. B. solange in operator.config.json noch der Platzhalter steht).
 */
import QRCode from "qrcode";

export interface EpcData {
  name: string;
  iban: string;
  bic?: string;
  amountCents: number;
  reference: string;
}

export function isValidIban(raw: string): boolean {
  const s = (raw || "").replace(/\s+/g, "").toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s);
}

/** EPC-QR-Nutzlast (BCD/SCT, Version 002, UTF-8) oder null bei ungültiger IBAN. */
export function epcQrPayload(p: EpcData): string | null {
  const iban = (p.iban || "").replace(/\s+/g, "").toUpperCase();
  if (!isValidIban(iban)) return null;
  const amount = "EUR" + (p.amountCents / 100).toFixed(2);
  const name = (p.name || "").slice(0, 70);
  const bic = (p.bic || "").replace(/\s+/g, "").toUpperCase().slice(0, 11);
  const ref = (p.reference || "").slice(0, 140);
  // Zeilen: BCD, Version, Zeichensatz, SCT, BIC, Name, IBAN, Betrag,
  //         Purpose(leer), strukturierte Referenz(leer), unstrukturierter Text.
  return ["BCD", "002", "1", "SCT", bic, name, iban, amount, "", "", ref].join("\n");
}

export async function epcQrDataUrl(p: EpcData): Promise<string | null> {
  const payload = epcQrPayload(p);
  if (!payload) return null;
  return QRCode.toDataURL(payload, { errorCorrectionLevel: "M", margin: 1, width: 240 });
}

export async function epcQrPngBuffer(p: EpcData): Promise<Buffer | null> {
  const payload = epcQrPayload(p);
  if (!payload) return null;
  return QRCode.toBuffer(payload, { errorCorrectionLevel: "M", margin: 1, width: 300 });
}
