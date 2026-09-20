import { useEffect, useState } from "react";
import { api, type OperatorInfo } from "./api";

/**
 * Betreiberdaten (Bank, Firma, Support) im Admin editierbar. Wird über die
 * operator.config.json gelegt und in der DB gespeichert — kein Datei-Zugriff nötig.
 */
export function OperatorSettings() {
  const [o, setO] = useState<OperatorInfo | null>(null);
  const [fromFile, setFromFile] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    api.getOperator().then((r) => { setO(r.operator); setFromFile(r.fromFile); }).catch((e) => setErr((e as Error).message));
  }, []);

  if (err) return <div className="panel"><p className="err">{err}</p></div>;
  if (!o) return <div className="panel">Lädt…</div>;

  const set = (k: keyof OperatorInfo, v: string) => setO({ ...o, [k]: v });
  const setBank = (k: keyof OperatorInfo["bank"], v: string) => setO({ ...o, bank: { ...o.bank, [k]: v } });

  async function save() {
    setMsg(""); setErr("");
    try {
      const r = await api.updateOperator(o!);
      setO(r.operator);
      setMsg("Gespeichert");
      setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2>Betreiberdaten & Bank</h2><button className="btn" onClick={save}>Speichern</button></div>
      {msg && <p className="note">{msg}</p>}
      {err && <p className="err">{err}</p>}
      <p className="muted" style={{ marginTop: 0 }}>
        Diese Daten stehen auf Rechnungen und im QR-Code für die Überweisung. Änderungen hier
        werden sofort gespeichert{fromFile ? " und überschreiben die Werte aus operator.config.json" : ""}.
      </p>

      <section className="sec">
        <h3>Bankverbindung (für Rechnung & QR-Code)</h3>
        <label className="field"><span>Kontoinhaber</span>
          <input value={o.bank.accountHolder} onChange={(e) => setBank("accountHolder", e.target.value)} /></label>
        <label className="field"><span>IBAN</span>
          <input value={o.bank.iban} onChange={(e) => setBank("iban", e.target.value)} placeholder="AT.. .... .... .... ...." /></label>
        <label className="field"><span>BIC</span>
          <input value={o.bank.bic} onChange={(e) => setBank("bic", e.target.value)} /></label>
        <label className="field"><span>Bank</span>
          <input value={o.bank.bankName} onChange={(e) => setBank("bankName", e.target.value)} /></label>
      </section>

      <section className="sec">
        <h3>Firma & Anschrift (Impressum/Rechnung)</h3>
        <label className="field"><span>Name / Firma</span>
          <input value={o.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label className="field"><span>Adresse</span>
          <textarea rows={3} value={o.address} onChange={(e) => set("address", e.target.value)} /></label>
        <label className="field"><span>UID / Steuernummer</span>
          <input value={o.uid} onChange={(e) => set("uid", e.target.value)} /></label>
        <label className="field"><span>Steuerhinweis</span>
          <input value={o.taxNote} onChange={(e) => set("taxNote", e.target.value)} /></label>
        <label className="field"><span>Währung</span>
          <input value={o.currency} onChange={(e) => set("currency", e.target.value)} /></label>
      </section>

      <section className="sec">
        <h3>Support-Kontakt</h3>
        <label className="field"><span>Support-E-Mail</span>
          <input value={o.supportEmail} onChange={(e) => set("supportEmail", e.target.value)} /></label>
        <label className="field"><span>Support-Telefon</span>
          <input value={o.supportPhone} onChange={(e) => set("supportPhone", e.target.value)} /></label>
      </section>
    </div>
  );
}
