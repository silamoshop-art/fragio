import { useEffect, useState } from "react";
import { api, type OperatorInfo, type MailInfo } from "./api";

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

/**
 * E-Mail-Versand (SMTP) + Empfänger für Benachrichtigungen — im Admin editierbar.
 * Ohne gültigen SMTP-Zugang werden E-Mails NICHT verschickt (nur im Serverlog notiert).
 */
export function MailSettings() {
  const [m, setM] = useState<MailInfo | null>(null);
  const [pass, setPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getMail().then(setM).catch((e) => setErr((e as Error).message));
  }, []);

  if (err && !m) return <div className="panel"><p className="err">{err}</p></div>;
  if (!m) return <div className="panel">Lädt…</div>;

  const set = (k: keyof MailInfo, v: string | number | boolean) => setM({ ...m, [k]: v } as MailInfo);

  async function save() {
    setMsg(""); setErr("");
    try {
      const r = await api.updateMail({
        host: m!.host, port: Number(m!.port) || 587, secure: m!.secure,
        user: m!.user, from: m!.from, notifyEmail: m!.notifyEmail,
        // Passwort/API-Key nur senden, wenn etwas eingegeben wurde (leer = unverändert).
        ...(pass ? { pass } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      setPass(""); setApiKey("");
      const fresh = await api.getMail();
      setM(fresh);
      setMsg(r.mail.enabled ? "Gespeichert — Versand aktiv." : "Gespeichert. Hinweis: ohne Host/Benutzer/Passwort wird nichts verschickt.");
      setTimeout(() => setMsg(""), 4000);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function test() {
    setMsg(""); setErr(""); setBusy(true);
    try {
      const r = await api.testMail();
      setMsg(`Test-E-Mail an ${r.sentTo} gesendet. Bitte Posteingang prüfen.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2>E-Mail-Versand</h2><button className="btn" onClick={save}>Speichern</button></div>
      {msg && <p className="note">{msg}</p>}
      {err && <p className="err">{err}</p>}
      <p className="muted" style={{ marginTop: 0 }}>
        Damit werden Bestellbestätigungen, Rechnungen, 80-%-Warnungen und Kontaktanfragen
        wirklich verschickt. Status:{" "}
        <strong style={{ color: m.enabled ? "#16a34a" : "#dc2626" }}>
          {m.mode === "http" ? "aktiv (über API)" : m.mode === "smtp" ? "aktiv (SMTP)" : "nicht aktiv"}
        </strong>.
      </p>

      <section className="sec">
        <h3>Empfänger für Benachrichtigungen</h3>
        <label className="field"><span>Deine E-Mail (Leads, Bestellungen, Warnungen)</span>
          <input type="email" value={m.notifyEmail} onChange={(e) => set("notifyEmail", e.target.value)} placeholder="du@firma.at" /></label>
      </section>

      <section className="sec">
        <h3>Empfohlen: Versand über API (Brevo)</h3>
        <p className="muted" style={{ margin: "0 0 8px", lineHeight: 1.5 }}>
          Funktioniert auch, wenn dein Server ausgehende SMTP-Ports sperrt (z. B. netcup) — der
          Versand läuft dann über HTTPS. Kostenloses Konto bei <strong>brevo.com</strong> anlegen,
          Absender-Adresse dort verifizieren, dann API-Key (v3) hier einfügen.
        </p>
        <label className="field"><span>Brevo API-Key {m.hasApiKey && <span className="muted">(gesetzt — leer lassen = unverändert)</span>}</span>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={m.hasApiKey ? "••••••••" : "xkeysib-…"} /></label>
        <p className="muted" style={{ margin: "6px 0 0" }}>Ist ein API-Key gesetzt, wird er bevorzugt (statt SMTP).</p>
      </section>

      <section className="sec">
        <h3>Alternativ: SMTP-Zugang (Postausgang)</h3>
        <label className="field"><span>Host</span>
          <input value={m.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.deinanbieter.at" /></label>
        <label className="field"><span>Port</span>
          <input type="number" value={m.port} onChange={(e) => set("port", Number(e.target.value))} /></label>
        <label className="field" style={{ cursor: "pointer" }}><span>SSL (Port 465)</span>
          <input type="checkbox" checked={m.secure} onChange={(e) => set("secure", e.target.checked)} /></label>
        <label className="field"><span>Benutzer</span>
          <input value={m.user} onChange={(e) => set("user", e.target.value)} placeholder="postfach@firma.at" /></label>
        <label className="field"><span>Passwort {m.hasPassword && <span className="muted">(gesetzt — leer lassen = unverändert)</span>}</span>
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={m.hasPassword ? "••••••••" : "Passwort"} /></label>
        <label className="field"><span>Absender (optional)</span>
          <input value={m.from} onChange={(e) => set("from", e.target.value)} placeholder='Fragio <no-reply@firma.at>' /></label>
      </section>

      <button className="btn ghost" onClick={test} disabled={busy}>{busy ? "Sende…" : "Test-E-Mail senden"}</button>
    </div>
  );
}
