import { useEffect, useState } from "react";
import { api, type Pricing } from "./api";

const euro = (cents: number) => (cents / 100).toFixed(2);
const toCents = (v: string) => Math.round(parseFloat(v || "0") * 100);

/** Global konfigurierbare Preise (Tarife, Einrichtungsgebühr, Branding-Aufpreise). */
export function PricingSettings() {
  const [p, setP] = useState<Pricing | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    api.getPricing().then(setP).catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <div className="panel"><p className="err">{err}</p></div>;
  if (!p) return <div className="panel">Lädt…</div>;

  const setPlan = (id: "starter" | "business" | "pro", key: "limit" | "setupMonthlyCents" | "commitMonthlyCents", val: number) =>
    setP({ ...p, plans: { ...p.plans, [id]: { ...p.plans[id], [key]: val } } });

  async function saveAll() {
    setMsg(""); setErr("");
    try { await api.updatePricing(p!); setMsg("Gespeichert ✓"); setTimeout(() => setMsg(""), 2000); }
    catch (e) { setErr((e as Error).message); }
  }

  return (
    <div className="panel">
      <div className="panel-head"><h2>Preise & Einstellungen</h2><button className="btn" onClick={saveAll}>Speichern</button></div>
      {msg && <p className="note">{msg}</p>}
      {err && <p className="err">{err}</p>}

      <section className="sec">
        <h3>Tarife (€/Monat)</h3>
        {(["starter", "business", "pro"] as const).map((id) => (
          <div key={id} style={{ marginBottom: 14 }}>
            <strong style={{ textTransform: "capitalize" }}>{id}</strong>
            <div className="field"><span>Anfragen/Monat</span>
              <input type="number" defaultValue={p.plans[id].limit} onBlur={(e) => setPlan(id, "limit", Math.round(+e.target.value))} /></div>
            <div className="field"><span>Mit Einrichtung (€/Mon)</span>
              <input type="number" step="0.01" defaultValue={euro(p.plans[id].setupMonthlyCents)} onBlur={(e) => setPlan(id, "setupMonthlyCents", toCents(e.target.value))} /></div>
            <div className="field"><span>6-Mon-Bindung (€/Mon)</span>
              <input type="number" step="0.01" defaultValue={euro(p.plans[id].commitMonthlyCents)} onBlur={(e) => setPlan(id, "commitMonthlyCents", toCents(e.target.value))} /></div>
          </div>
        ))}
      </section>

      <section className="sec">
        <h3>Einrichtung & Bindung</h3>
        <div className="field"><span>Einrichtungsgebühr (€)</span>
          <input type="number" step="0.01" defaultValue={euro(p.setupFeeCents)} onBlur={(e) => setP({ ...p, setupFeeCents: toCents(e.target.value) })} /></div>
        <div className="field"><span>Bindung (Monate)</span>
          <input type="number" defaultValue={p.commitMonths} onBlur={(e) => setP({ ...p, commitMonths: Math.round(+e.target.value) })} /></div>
      </section>

      <section className="sec">
        <h3>Branding-Aufpreise (€/Monat)</h3>
        <div className="field"><span>Eigenes Logo</span>
          <input type="number" step="0.01" defaultValue={euro(p.addons.logoCents)} onBlur={(e) => setP({ ...p, addons: { ...p.addons, logoCents: toCents(e.target.value) } })} /></div>
        <div className="field"><span>Eigener Bot-Name</span>
          <input type="number" step="0.01" defaultValue={euro(p.addons.nameCents)} onBlur={(e) => setP({ ...p, addons: { ...p.addons, nameCents: toCents(e.target.value) } })} /></div>
        <div className="field"><span>Bundle (beide)</span>
          <input type="number" step="0.01" defaultValue={euro(p.addons.bundleCents)} onBlur={(e) => setP({ ...p, addons: { ...p.addons, bundleCents: toCents(e.target.value) } })} /></div>
      </section>
      <p className="muted">Änderungen gelten global; individuelle Kundenrabatte pro Bot bleiben davon unberührt.</p>
    </div>
  );
}
