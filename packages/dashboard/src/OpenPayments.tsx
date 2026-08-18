import { useEffect, useState } from "react";
import { api, openInvoicePdf, type OpenPayment } from "./api";

const money = (cents: number, cur: string) => (cents / 100).toFixed(2).replace(".", ",") + " " + cur;
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString("de-AT");

/** „Offene Zahlungen" (Section D): unbezahlte Rechnungen + Als bezahlt / Mahnung. */
export function OpenPayments() {
  const [rows, setRows] = useState<OpenPayment[] | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  async function load() {
    try {
      setRows(await api.openPayments());
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function markPaid(id: number) {
    setBusy(id); setErr(""); setMsg("");
    try {
      await api.markInvoicePaid(id);
      setMsg("Als bezahlt markiert ✓");
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setMsg(""), 2500);
    }
  }

  async function sendReminder(id: number) {
    setBusy(id); setErr(""); setMsg("");
    try {
      const r = await api.sendReminder(id);
      setMsg(`Mahnung an ${r.sentTo} gesendet${r.attached ? " (mit Rechnung)" : ""} ✓`);
      await load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
      setTimeout(() => setMsg(""), 3500);
    }
  }

  if (err && !rows) return <div className="panel"><p className="err">{err}</p></div>;
  if (!rows) return <div className="panel">Lädt…</div>;

  const total = rows.reduce((s, r) => s + r.amountCents, 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Offene Zahlungen</h2>
        {rows.length > 0 && (
          <span className="muted">
            {rows.length} offen · {money(total, rows[0].currency)}
          </span>
        )}
      </div>
      {msg && <p className="note">{msg}</p>}
      {err && <p className="err">{err}</p>}

      {rows.length === 0 ? (
        <p className="muted">Keine offenen Rechnungen — alles beglichen. 🎉</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>Kunde / Bot</th>
              <th>Rechnung</th>
              <th>Betrag</th>
              <th>Fällig</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.customerName || "—"}</strong>
                  <div className="muted">{r.botName}</div>
                  {r.customerEmail ? <div className="muted">{r.customerEmail}</div> : <div className="err">keine E-Mail</div>}
                </td>
                <td>
                  <button className="linklike" onClick={() => openInvoicePdf(r.id).catch((e) => setErr((e as Error).message))}>
                    {r.invoiceNumber}
                  </button>
                  <div className="muted">{r.periodLabel}</div>
                </td>
                <td>{money(r.amountCents, r.currency)}</td>
                <td>
                  {fmtDate(r.dueDate)}
                  {r.overdue && <span className="tag warn" style={{ marginLeft: 6 }}>überfällig</span>}
                  {r.reminderSentAt && <div className="muted">Mahnung: {fmtDate(r.reminderSentAt)}</div>}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="btn sm" disabled={busy === r.id} onClick={() => markPaid(r.id)}>Als bezahlt markieren</button>{" "}
                  <button className="btn ghost sm" disabled={busy === r.id || !r.customerEmail} onClick={() => sendReminder(r.id)}>Mahnung senden</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
