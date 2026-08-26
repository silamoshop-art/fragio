import { useEffect, useState, type CSSProperties } from "react";
import { api, getToken, setToken, clearToken, type Overview, type Plan, type QItem, type VariantId, type AddonsResp, type AddonStatus, type PortalChatLog, type ManualFaq } from "./api";

/* Farben exakt aus dem gelieferten Design (oklch). */
const C = {
  accent: "oklch(0.55 0.16 258)",
  accentSoftBg: "oklch(0.93 0.03 258)",
  accentSoftText: "oklch(0.4 0.13 258)",
  textPrimary: "oklch(0.22 0.01 258)",
  textSecondary: "oklch(0.48 0.01 258)",
  border: "oklch(0.92 0.005 258)",
  green: "oklch(0.6 0.14 145)",
  yellow: "oklch(0.7 0.14 85)",
  red: "oklch(0.58 0.19 25)",
  bg: "oklch(0.985 0.003 258)",
};
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
const fmt = (n: number) => n.toLocaleString("de-DE");

// Ehrliche, tatsächlich zutreffende Punkte (Einzelunternehmen, eine Website pro Bot).
// Keine erfundenen „Prio-Stufen" oder „Ansprechpartner-Teams", keine Multi-Website-Angaben.
const PLAN_FEATURES: Record<string, string[]> = {
  starter: ["500 Anfragen pro Monat", "Eine Website", "Individuelle Einrichtung", "Support per E-Mail"],
  business: ["2.000 Anfragen pro Monat", "Eine Website", "Individuelle Einrichtung", "Support per E-Mail"],
  pro: ["5.000 Anfragen pro Monat", "Eine Website", "Individuelle Einrichtung", "Support per E-Mail"],
};

function useIsMobile() {
  const [m, setM] = useState(
    typeof window !== "undefined" && window.matchMedia("(max-width: 780px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 780px)");
    const on = (e: MediaQueryListEvent) => setM(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Portal onLogout={() => { clearToken(); setAuthed(false); }} />;
}

/* ---------- Login (Palette wie Design; Design selbst hatte keinen Login) ---------- */
function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await api.login(email.trim(), password);
      setToken(res.token);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: C.bg, fontFamily: FONT, padding: 20 }}>
      <form onSubmit={submit} style={{ width: 380, maxWidth: "100%", background: "#fff", border: `1px solid ${C.border}`, borderRadius: 20, padding: 32, boxShadow: "0 8px 24px oklch(0.2 0.01 258 / 0.06)" }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: C.textPrimary, marginBottom: 6 }}>Kundenportal</div>
        <h1 style={{ fontSize: 26, fontWeight: 650, color: C.textPrimary, margin: "0 0 24px", letterSpacing: "-0.02em" }}>Anmelden</h1>
        <label style={labelStyle}>E-Mail</label>
        <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label style={{ ...labelStyle, marginTop: 14 }}>Passwort</label>
        <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {err && <p style={{ color: C.red, fontSize: 14, margin: "12px 0 0" }}>{err}</p>}
        <button disabled={busy} style={{ ...primaryBtn, width: "100%", marginTop: 20 }}>{busy ? "…" : "Anmelden"}</button>
      </form>
    </div>
  );
}
const labelStyle: CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: C.textSecondary, marginBottom: 6 };
const inputStyle: CSSProperties = { width: "100%", padding: "11px 14px", borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 15, color: C.textPrimary, outline: "none" };
const primaryBtn: CSSProperties = { background: C.accent, color: "#fff", border: "none", padding: "13px 24px", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" };

/* ---------- Portal-Shell ---------- */
function Portal({ onLogout }: { onLogout: () => void }) {
  const isMobile = useIsMobile();
  const [screen, setScreen] = useState(0);
  const screens = ["Übersicht", "Tarife", "Fragen", "FAQ-Antworten", "Einbindung", "Support"];

  const rootStyle: CSSProperties = {
    display: "flex",
    flexDirection: isMobile ? "column-reverse" : "row",
    minHeight: "100vh",
    background: C.bg,
    fontFamily: FONT,
    color: C.textPrimary,
  };
  const navStyle: CSSProperties = isMobile
    ? { display: "flex", gap: 4, padding: "10px 12px", background: "#fff", borderTop: `1px solid ${C.border}`, position: "sticky", bottom: 0 }
    : { display: "flex", flexDirection: "column", width: 240, flexShrink: 0, padding: "32px 16px", borderRight: `1px solid ${C.border}`, gap: 4 };

  return (
    <div style={rootStyle}>
      <nav style={navStyle}>
        {!isMobile && <div style={{ fontSize: 17, fontWeight: 700, color: C.textPrimary, padding: "0 16px", marginBottom: 28, letterSpacing: "-0.01em" }}>Kundenportal</div>}
        <div style={{ display: "flex", flexDirection: isMobile ? "row" : "column", flex: isMobile ? 1 : undefined, gap: 4 }}>
          {screens.map((label, i) => {
            const active = screen === i;
            return (
              <button
                key={i}
                onClick={() => setScreen(i)}
                style={{
                  textAlign: isMobile ? "center" : "left",
                  flex: isMobile ? 1 : "none",
                  border: "none",
                  cursor: "pointer",
                  background: active ? C.accentSoftBg : "transparent",
                  color: active ? C.accentSoftText : C.textSecondary,
                  fontSize: isMobile ? 12 : 15,
                  fontWeight: active ? 600 : 500,
                  padding: isMobile ? "10px 4px" : "11px 16px",
                  borderRadius: 10,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        {!isMobile && (
          <button onClick={onLogout} style={{ marginTop: "auto", border: "none", background: "transparent", color: C.textSecondary, fontSize: 13, cursor: "pointer", textAlign: "left", padding: "11px 16px" }}>Abmelden</button>
        )}
      </nav>

      <main style={{ flex: 1, padding: isMobile ? "28px 20px 20px" : "48px 56px", overflow: "auto" }}>
        {screen === 0 && <Overview onGoToPlans={() => setScreen(1)} />}
        {screen === 1 && <Plans isMobile={isMobile} />}
        {screen === 2 && <Questions />}
        {screen === 3 && <Faqs />}
        {screen === 4 && <Embed />}
        {screen === 5 && <Support />}
      </main>
    </div>
  );
}

function h1Style(): CSSProperties {
  return { fontSize: 34, fontWeight: 650, color: C.textPrimary, margin: "0 0 8px", letterSpacing: "-0.02em" };
}

/* ---------- Screen 0: Übersicht / Verbrauch ---------- */
function Overview({ onGoToPlans }: { onGoToPlans: () => void }) {
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.overview().then(setOv).catch((e) => setErr((e as Error).message));
  }, []);
  if (err) return <p style={{ color: C.red }}>{err}</p>;
  if (!ov) return <p style={{ color: C.textSecondary }}>Lädt…</p>;

  const { pct, status } = ov.usage;
  const barColor = status === "full" ? C.red : status === "warn" ? C.yellow : C.green;
  const statusMsg = status === "full" ? "Limit erreicht" : status === "warn" ? "Kontingent bald erreicht" : null;
  const statusColor = status === "full" ? C.red : "oklch(0.5 0.1 85)";
  const showUpgrade = pct >= 70;

  return (
    <div style={{ maxWidth: 720 }}>
      <p style={{ fontSize: 15, color: C.textSecondary, margin: "0 0 4px" }}>Aktueller Tarif</p>
      <h1 style={{ ...h1Style(), margin: "0 0 32px" }}>
        {ov.planName ? `${ov.planName} — ${ov.priceCents / 100} €/Monat` : "Kein Tarif gewählt"}
      </h1>

      <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 20, padding: 32, boxShadow: "0 1px 3px oklch(0.2 0.01 258 / 0.04), 0 8px 24px oklch(0.2 0.01 258 / 0.05)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <span style={{ fontSize: 17, fontWeight: 600, color: C.textPrimary }}>Anfragen diesen Monat</span>
          <span style={{ fontSize: 17, fontWeight: 600, color: C.textPrimary }}>
            {fmt(ov.usage.used)} / {fmt(ov.usage.quota)} <span style={{ color: C.textSecondary, fontWeight: 500 }}>({pct}%)</span>
          </span>
        </div>
        <div style={{ width: "100%", height: 14, background: "oklch(0.94 0.004 258)", borderRadius: 999, overflow: "hidden" }}>
          <div style={{ width: `${pct}%`, height: "100%", background: barColor, borderRadius: 999, transition: "width 0.3s ease" }} />
        </div>
        {statusMsg && <p style={{ margin: "14px 0 0", fontSize: 14, color: statusColor, fontWeight: 500 }}>{statusMsg}</p>}
        {showUpgrade && (
          <button onClick={onGoToPlans} style={{ marginTop: 24, background: C.accentSoftBg, color: C.accentSoftText, border: "none", padding: "13px 24px", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Jetzt upgraden</button>
        )}
      </div>
      <p style={{ margin: "20px 4px 0", fontSize: 13, color: "oklch(0.55 0.01 258)" }}>Dein Kontingent setzt sich monatlich am Abrechnungsdatum zurück.</p>
    </div>
  );
}

/* ---------- Screen 1: Tarife (2 Varianten je Karte) ---------- */
function Plans({ isMobile }: { isMobile: boolean }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [variant, setVariant] = useState<Record<string, VariantId>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    Promise.all([api.plans(), api.overview()])
      .then(([p, o]) => { setPlans(p.plans); setCurrentId(o.planId); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const vOf = (id: string): VariantId => variant[id] || "setup";

  async function request(planId: string, v: VariantId) {
    setBusy(planId);
    setMsg("");
    setErr("");
    try {
      const r = await api.requestPlan(planId, v);
      if (r.mode === "checkout" && r.url) { window.location.href = r.url; return; }
      setMsg(r.message || "Anfrage gesendet — du bekommst in Kürze eine Rechnung per E-Mail.");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <h1 style={h1Style()}>Tarife</h1>
      <p style={{ fontSize: 16, color: C.textSecondary, margin: "0 0 32px" }}>Wähle Tarif und Abrechnungsvariante — wir schicken dir die passende Rechnung.</p>
      {err && <p style={{ color: C.red }}>{err}</p>}
      {msg && <p style={{ background: "oklch(0.96 0.03 145)", border: "1px solid oklch(0.8 0.1 145)", color: "oklch(0.35 0.09 145)", padding: "12px 16px", borderRadius: 12, fontSize: 14, fontWeight: 500 }}>✓ {msg}</p>}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, 1fr)", gap: 20 }}>
        {plans.map((p) => {
          const isCurrent = p.id === currentId;
          const v = vOf(p.id);
          const monthly = (v === "commit" ? p.commit.monthlyCents : p.setup.monthlyCents) / 100;
          return (
            <div key={p.id} style={{ background: "#fff", borderRadius: 20, padding: 28, border: isCurrent ? `2px solid ${C.accent}` : `1px solid ${C.border}`, boxShadow: isCurrent ? "0 8px 24px oklch(0.55 0.16 258 / 0.12)" : "0 1px 3px oklch(0.2 0.01 258 / 0.04)" }}>
              {isCurrent && <span style={{ display: "inline-block", background: C.accentSoftBg, color: C.accentSoftText, fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 999, marginBottom: 16 }}>Aktueller Tarif</span>}
              <h2 style={{ fontSize: 22, fontWeight: 650, color: C.textPrimary, margin: "0 0 14px" }}>{p.name}</h2>

              {/* Umschalter: Mit Einrichtung / Ohne Einrichtung, 6 Monate Bindung */}
              <div style={{ display: "flex", background: "oklch(0.96 0.004 258)", borderRadius: 10, padding: 3, marginBottom: 16 }}>
                {(["setup", "commit"] as VariantId[]).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setVariant((s) => ({ ...s, [p.id]: opt }))}
                    style={{ flex: 1, border: "none", cursor: "pointer", borderRadius: 8, padding: "8px 6px", fontSize: 12, fontWeight: 600, lineHeight: 1.2, background: v === opt ? "#fff" : "transparent", color: v === opt ? C.textPrimary : C.textSecondary, boxShadow: v === opt ? "0 1px 2px oklch(0.2 0.01 258 / 0.12)" : "none" }}
                  >
                    {opt === "setup" ? "Mit Einrichtung" : "6 Monate Bindung"}
                  </button>
                ))}
              </div>

              <p style={{ fontSize: 28, fontWeight: 650, color: C.textPrimary, margin: "0 0 2px" }}>{monthly} €<span style={{ fontSize: 15, fontWeight: 500, color: C.textSecondary }}>/Monat</span></p>
              <p style={{ fontSize: 13, color: C.textSecondary, margin: "0 0 18px" }}>
                {v === "setup"
                  ? `+ ${p.setup.setupCents / 100} € Einrichtung · monatlich kündbar`
                  : `${p.commit.commitmentMonths} Monate Bindung · keine Einrichtung`}
              </p>

              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
                {(PLAN_FEATURES[p.id] || []).map((f, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, fontSize: 14, color: "oklch(0.38 0.01 258)", lineHeight: 1.4 }}>
                    <span style={{ color: C.accent, fontWeight: 700 }}>–</span>
                    <span>{f}</span>
                  </div>
                ))}
              </div>

              <button
                onClick={() => request(p.id, v)}
                disabled={busy === p.id}
                style={{ width: "100%", padding: "13px 20px", borderRadius: 12, fontSize: 15, fontWeight: 600, border: "none", cursor: "pointer", background: C.accent, color: "#fff" }}
              >
                {busy === p.id ? "…" : "Anfragen"}
              </button>
            </div>
          );
        })}
      </div>

      <Addons onMessage={setMsg} />
    </div>
  );
}

/* ---------- Screen 4: Support-Kontakt ---------- */
function Support() {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const r = await api.support(message.trim(), email.trim());
      setSent(r.message);
      setMessage("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 640 }}>
      <h1 style={h1Style()}>Support</h1>
      <p style={{ fontSize: 16, color: C.textSecondary, margin: "0 0 24px" }}>
        Schreib uns direkt — wir melden uns per E-Mail zurück.
      </p>
      {sent ? (
        <div style={{ background: "oklch(0.96 0.03 145)", border: "1px solid oklch(0.8 0.1 145)", color: "oklch(0.35 0.09 145)", padding: "16px 18px", borderRadius: 14, fontSize: 15 }}>
          ✓ {sent}
          <div style={{ marginTop: 10 }}>
            <button onClick={() => setSent("")} style={{ border: "none", background: "transparent", color: C.accent, fontWeight: 600, cursor: "pointer", padding: 0 }}>Weitere Nachricht senden</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 18, padding: 24 }}>
          <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.textPrimary, marginBottom: 6 }}>Deine Nachricht</label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} required rows={6} placeholder="Wie können wir helfen?" style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: `1px solid ${C.border}`, fontSize: 15, resize: "vertical", fontFamily: "inherit", color: C.textPrimary }} />
          <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.textPrimary, margin: "14px 0 6px" }}>E-Mail für Rückantwort <span style={{ color: C.textSecondary, fontWeight: 400 }}>(optional)</span></label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="du@firma.at" style={{ width: "100%", padding: "11px 14px", borderRadius: 12, border: `1px solid ${C.border}`, fontSize: 15, color: C.textPrimary }} />
          {err && <p style={{ color: C.red, fontSize: 14 }}>{err}</p>}
          <button disabled={busy} style={{ marginTop: 18, background: C.accent, color: "#fff", border: "none", padding: "13px 24px", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{busy ? "…" : "Absenden"}</button>
        </form>
      )}
    </div>
  );
}

/* ---------- Zusatzoptionen (Branding-Add-ons) ---------- */
function Addons({ onMessage }: { onMessage: (m: string) => void }) {
  const [a, setA] = useState<AddonsResp | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [logoUrl, setLogoUrl] = useState<string>("");
  useEffect(() => {
    api.addons().then(setA).catch(() => {});
  }, []);

  async function onLogoFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setUploading(true);
    onMessage("");
    try {
      const r = await api.uploadLogo(f);
      setLogoUrl(r.logoUrl);
      onMessage("Logo hochgeladen ✓ — beim nächsten Laden des Chats sichtbar.");
    } catch (err) {
      onMessage("⚠️ " + (err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  if (!a) return null;

  async function req(addon: "logo" | "name" | "bundle") {
    setBusy(addon);
    onMessage("");
    try {
      const r = await api.requestAddon(addon);
      onMessage(r.message || "Anfrage gesendet.");
      setA(await api.addons());
    } catch (e) {
      onMessage("⚠️ " + (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const items: { key: "logo" | "name" | "bundle"; label: string; hint: string; s: { priceCents: number; status: AddonStatus } }[] = [
    { key: "logo", label: "Eigenes Logo", hint: "Dein Logo im Chat-Fenster", s: a.logo },
    { key: "name", label: "Eigener Bot-Name", hint: "Individueller Name statt Standard", s: a.name },
    { key: "bundle", label: "Bundle: Logo + Name", hint: "Beides zusammen — günstiger", s: a.bundle },
  ];

  const badge = (status: AddonStatus) =>
    status === "active"
      ? { text: "Aktiv ✓", color: C.green }
      : status === "pending"
        ? { text: "Angefragt …", color: C.yellow }
        : null;

  return (
    <div style={{ marginTop: 40 }}>
      <h2 style={{ fontSize: 18, fontWeight: 650, color: C.textPrimary, margin: "0 0 4px" }}>Zusatzoptionen</h2>
      <p style={{ fontSize: 14, color: C.textSecondary, margin: "0 0 16px" }}>Erst nach Freischaltung nutzbar.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16 }}>
        {items.map((it) => {
          const b = badge(it.s.status);
          const disabled = it.s.status !== "available" || busy === it.key;
          return (
            <div key={it.key} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 20, opacity: it.s.status === "available" ? 1 : 0.65 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                <strong style={{ color: C.textPrimary }}>{it.label}</strong>
                {b && <span style={{ fontSize: 12, fontWeight: 600, color: b.color }}>{b.text}</span>}
              </div>
              <p style={{ fontSize: 13, color: C.textSecondary, margin: "4px 0 12px" }}>{it.hint}</p>
              <p style={{ fontSize: 20, fontWeight: 650, color: C.textPrimary, margin: "0 0 12px" }}>
                +{it.s.priceCents / 100} €<span style={{ fontSize: 13, fontWeight: 500, color: C.textSecondary }}>/Monat</span>
              </p>
              <button
                onClick={() => req(it.key)}
                disabled={disabled}
                style={{ width: "100%", padding: "10px 14px", borderRadius: 10, fontSize: 14, fontWeight: 600, border: "none", cursor: disabled ? "default" : "pointer", background: disabled ? "oklch(0.95 0.005 258)" : C.accent, color: disabled ? C.textSecondary : "#fff" }}
              >
                {it.s.status === "active" ? "Freigeschaltet" : it.s.status === "pending" ? "In Bearbeitung" : busy === it.key ? "…" : "Anfragen"}
              </button>
            </div>
          );
        })}
      </div>

      {a.logo.status === "active" && (
        <div style={{ marginTop: 20, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 16, padding: 20 }}>
          <strong style={{ color: C.textPrimary }}>Logo hochladen</strong>
          <p style={{ fontSize: 13, color: C.textSecondary, margin: "4px 0 12px" }}>
            PNG, JPG oder SVG, max. 2 MB. Erscheint im Kopf des Chat-Fensters.
          </p>
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml"
            onChange={onLogoFile}
            disabled={uploading}
          />
          {logoUrl && (
            <div style={{ marginTop: 12 }}>
              <img src={logoUrl} alt="Aktuelles Logo" style={{ maxHeight: 64, maxWidth: 200, borderRadius: 8 }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------- Screen 2: Fragen ---------- */
function Questions() {
  const [top, setTop] = useState<QItem[]>([]);
  const [un, setUn] = useState<QItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [logs, setLogs] = useState<PortalChatLog[] | null>(null);
  const [logMsg, setLogMsg] = useState("");
  const [logSearch, setLogSearch] = useState("");
  const [correctId, setCorrectId] = useState<number | null>(null);
  const [correctText, setCorrectText] = useState("");
  useEffect(() => {
    api.analytics().then((a) => { setTop(a.topQuestions); setUn(a.unanswered); setLoaded(true); }).catch((e) => setErr((e as Error).message));
  }, []);

  async function loadLogs(search?: string) {
    try { setLogs(await api.chatLogs(search ?? logSearch)); } catch (e) { setLogMsg("⚠️ " + (e as Error).message); }
  }
  async function delSender(ipHash: string) {
    if (!confirm("Alle Chat-Anfragen dieses Absenders (gleicher IP-Hash) unwiderruflich löschen?")) return;
    try {
      const r = await api.deleteBySender(ipHash);
      setLogMsg(`✓ ${r.deleted} Eintrag/Einträge gelöscht.`);
      await loadLogs();
    } catch (e) { setLogMsg("⚠️ " + (e as Error).message); }
  }
  // Korrektur = eigene (recrawl-feste) Antwort, künftig bei ähnlichen Fragen bevorzugt.
  async function saveCorrection(question: string) {
    if (!correctText.trim()) { setLogMsg("Bitte die richtige Antwort eingeben."); return; }
    try {
      await api.createFaq({ question, answer: correctText.trim() });
      setLogMsg("✓ Als richtige Antwort gespeichert — wird künftig bei ähnlichen Fragen bevorzugt (übersteht Aktualisierungen).");
      setCorrectId(null);
    } catch (e) { setLogMsg("⚠️ " + (e as Error).message); }
  }

  const row = (last: boolean, tint: string): CSSProperties => ({
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px",
    borderBottom: last ? "none" : `1px solid ${tint}`,
  });

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={{ ...h1Style(), margin: "0 0 32px" }}>Fragen &amp; Verständnis</h1>
      {err && <p style={{ color: C.red }}>{err}</p>}

      <section>
        <h2 style={{ fontSize: 18, fontWeight: 650, color: C.textPrimary, margin: "0 0 4px" }}>Häufigste Fragen</h2>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: "0 0 16px" }}>Letzte 30 Tage</p>
        <div style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 18, overflow: "hidden" }}>
          {top.length === 0 && <div style={{ padding: "16px 20px", fontSize: 14, color: C.textSecondary }}>{loaded ? "Noch keine Fragen in den letzten 30 Tagen." : "Lädt…"}</div>}
          {top.map((q, i) => (
            <div key={i} style={row(i === top.length - 1, C.border)}>
              <span style={{ fontSize: 15, color: "oklch(0.28 0.01 258)" }}>{q.question}</span>
              <span style={{ fontSize: 14, color: "oklch(0.5 0.01 258)", fontWeight: 600, whiteSpace: "nowrap", marginLeft: 16 }}>{q.count}×</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 650, color: C.textPrimary, margin: "0 0 4px" }}>Unbeantwortete Fragen</h2>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: "0 0 16px", lineHeight: 1.5 }}>Diese Fragen konnte der Bot nicht beantworten — evtl. fehlt dazu Content auf eurer Website.</p>
        <div style={{ background: "oklch(0.98 0.02 85)", borderLeft: "3px solid oklch(0.78 0.15 85)", borderRadius: "4px 14px 14px 4px", overflow: "hidden" }}>
          {un.length === 0 && <div style={{ padding: "16px 20px", fontSize: 14, color: "oklch(0.45 0.03 85)" }}>{loaded ? "Keine unbeantworteten Fragen — super!" : "Lädt…"}</div>}
          {un.map((q, i) => (
            <div key={i} style={row(i === un.length - 1, "oklch(0.9 0.04 85)")}>
              <span style={{ fontSize: 15, color: "oklch(0.32 0.02 85)" }}>{q.question}</span>
              <span style={{ fontSize: 14, color: "oklch(0.55 0.06 85)", fontWeight: 600, whiteSpace: "nowrap", marginLeft: 16 }}>{q.count}×</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 18, fontWeight: 650, color: C.textPrimary, margin: "0 0 4px" }}>Chat-Verläufe (vollständig, durchsuchbar)</h2>
        <p style={{ fontSize: 14, color: C.textSecondary, margin: "0 0 16px", lineHeight: 1.5 }}>
          Jede gespeicherte Frage + Antwort mit Datum. Absender werden nur als <strong>gehashte IP</strong> angezeigt (keine echte IP). „Absender löschen" entfernt alle Anfragen desselben Absenders (Art. 17 DSGVO).
        </p>
        <form onSubmit={(e) => { e.preventDefault(); loadLogs(); }} style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          <input value={logSearch} onChange={(e) => setLogSearch(e.target.value)} placeholder="In Fragen & Antworten suchen…" style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 14, color: C.textPrimary }} />
          <button type="submit" style={{ padding: "10px 16px", borderRadius: 10, border: "none", background: C.accent, color: "#fff", cursor: "pointer", fontWeight: 600 }}>Suchen</button>
          {logSearch && <button type="button" onClick={() => { setLogSearch(""); loadLogs(""); }} style={{ padding: "10px 14px", borderRadius: 10, border: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", fontWeight: 600, color: C.textSecondary }}>Zurücksetzen</button>}
        </form>
        {logMsg && <p style={{ fontSize: 14, color: C.textSecondary }}>{logMsg}</p>}
        {logs === null ? (
          <button onClick={() => loadLogs()} style={{ padding: "10px 16px", borderRadius: 10, border: `1px solid ${C.border}`, background: "#fff", cursor: "pointer", fontWeight: 600, color: C.textPrimary }}>Chat-Verläufe laden</button>
        ) : logs.length === 0 ? (
          <p style={{ fontSize: 14, color: C.textSecondary }}>{logSearch ? "Keine Treffer für die Suche." : "Keine gespeicherten Chat-Verläufe."}</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {logs.map((l) => (
              <div key={l.id} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 14, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: C.textSecondary, fontFamily: "ui-monospace, monospace" }}>
                    {new Date(l.createdAt).toLocaleString("de-AT")} · {l.ipHash ? l.ipHash.slice(0, 12) + "…" : "—"}
                    {!l.answered && <span style={{ marginLeft: 8, color: "oklch(0.55 0.12 85)", fontWeight: 600 }}>unbeantwortet</span>}
                  </span>
                  {l.ipHash && (
                    <button onClick={() => delSender(l.ipHash!)} style={{ flex: "0 0 auto", padding: "6px 12px", borderRadius: 8, border: "none", background: "oklch(0.55 0.18 25)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Absender löschen</button>
                  )}
                </div>
                <div style={{ marginTop: 8, fontSize: 14, color: "oklch(0.24 0.01 258)" }}><strong>F:</strong> {l.question}</div>
                <div style={{ marginTop: 4, fontSize: 14, color: C.textSecondary, whiteSpace: "pre-wrap" }}><strong style={{ color: "oklch(0.24 0.01 258)" }}>A:</strong> {l.answer || "—"}</div>
                {correctId === l.id ? (
                  <div style={{ marginTop: 8, borderTop: `1px dashed ${C.border}`, paddingTop: 8 }}>
                    <label style={{ fontSize: 13, fontWeight: 600, color: C.textPrimary }}>Richtige Antwort (wird bevorzugt genutzt)</label>
                    <textarea rows={3} value={correctText} onChange={(e) => setCorrectText(e.target.value)} style={{ width: "100%", marginTop: 4, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.border}`, fontSize: 14, resize: "vertical", fontFamily: "inherit" }} />
                    <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                      <button onClick={() => saveCorrection(l.question)} style={{ padding: "8px 14px", borderRadius: 8, border: "none", background: C.accent, color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Als richtige Antwort speichern</button>
                      <button onClick={() => setCorrectId(null)} style={{ padding: "8px 14px", borderRadius: 8, border: `1px solid ${C.border}`, background: "#fff", color: C.textSecondary, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Abbrechen</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setCorrectId(l.id); setCorrectText(l.answer || ""); setLogMsg(""); }} style={{ marginTop: 8, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: "#fff", color: C.textPrimary, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>✎ Korrigieren</button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------- Screen 3: Manuelle FAQ-Antworten (recrawl-fest) ---------- */
function Faqs() {
  const [faqs, setFaqs] = useState<ManualFaq[] | null>(null);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [editId, setEditId] = useState<number | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [style, setStyle] = useState("");
  const [styleMsg, setStyleMsg] = useState("");

  async function load() {
    try {
      setFaqs(await api.listFaqs());
      const s = await api.getStyle();
      setStyle(s.styleSample || "");
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function saveStyle() {
    setStyleMsg("");
    try {
      await api.setStyle(style.trim() ? style.trim() : null);
      setStyleMsg("✓ Schreibstil gespeichert.");
    } catch (e) {
      setStyleMsg("⚠️ " + (e as Error).message);
    }
  }

  function reset() {
    setQ("");
    setA("");
    setEditId(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setMsg("");
    if (q.trim().length < 2 || !a.trim()) {
      setErr("Frage (min. 2 Zeichen) und Antwort nötig.");
      return;
    }
    try {
      if (editId === null) {
        await api.createFaq({ question: q.trim(), answer: a.trim() });
        setMsg("FAQ hinzugefügt ✓");
      } else {
        await api.updateFaq(editId, { question: q.trim(), answer: a.trim() });
        setMsg("FAQ aktualisiert ✓");
      }
      reset();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Diese FAQ-Antwort löschen?")) return;
    try {
      await api.deleteFaq(id);
      if (editId === id) reset();
      await load();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  const card: CSSProperties = { background: "#fff", border: `1px solid ${C.border}`, borderRadius: 18, padding: 24 };
  const input: CSSProperties = { width: "100%", padding: "11px 14px", borderRadius: 12, border: `1px solid ${C.border}`, fontSize: 15, color: C.textPrimary, fontFamily: "inherit" };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 style={h1Style()}>Eigene Antworten</h1>
      <p style={{ fontSize: 16, color: C.textSecondary, margin: "0 0 24px", lineHeight: 1.5 }}>
        Hinterlege feste Antworten für häufige Fragen oder eine bestimmte gewünschte
        Formulierung. Sie werden <strong>vorrangig</strong> verwendet und bleiben bei
        jeder Aktualisierung eurer Website (Neu-Crawl) <strong>erhalten</strong>.
      </p>

      <div style={{ ...card, marginBottom: 28 }}>
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.textPrimary, marginBottom: 6 }}>Schreibstil (Tonfall)</label>
        <p style={{ fontSize: 13, color: C.textSecondary, margin: "0 0 8px", lineHeight: 1.5 }}>
          Ein kurzes Textbeispiel, an dessen <strong>Tonfall</strong> (Anrede du/Sie,
          Förmlichkeit, Satzlänge) sich der Bot orientiert — <strong>nicht</strong> am Inhalt.
          Leer = neutraler Standardton. Bleibt bei jeder Website-Aktualisierung erhalten.
        </p>
        <textarea style={{ ...input, resize: "vertical" }} rows={4} value={style} placeholder="z. B.: „Hey! Schön, dass du da bist. Wir kümmern uns locker und schnell um dein Anliegen – frag einfach drauflos!“" onChange={(e) => setStyle(e.target.value)} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
          <button type="button" onClick={saveStyle} style={{ background: C.accent, color: "#fff", border: "none", padding: "10px 18px", borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: "pointer" }}>Schreibstil speichern</button>
          {styleMsg && <span style={{ fontSize: 13, color: C.textSecondary }}>{styleMsg}</span>}
        </div>
      </div>

      <form onSubmit={submit} style={{ ...card, marginBottom: 28 }}>
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.textPrimary, marginBottom: 6 }}>
          {editId === null ? "Frage / typische Formulierung des Besuchers" : "Frage bearbeiten"}
        </label>
        <input style={input} value={q} placeholder="z. B. Bietet ihr kostenlose Parkplätze?" onChange={(e) => setQ(e.target.value)} />
        <label style={{ display: "block", fontSize: 14, fontWeight: 600, color: C.textPrimary, margin: "14px 0 6px" }}>Gewünschte Antwort</label>
        <textarea style={{ ...input, resize: "vertical" }} rows={4} value={a} placeholder="Die Antwort, die der Bot geben soll…" onChange={(e) => setA(e.target.value)} />
        {err && <p style={{ color: C.red, fontSize: 14, margin: "12px 0 0" }}>{err}</p>}
        {msg && <p style={{ color: "oklch(0.45 0.12 145)", fontSize: 14, margin: "12px 0 0", fontWeight: 500 }}>✓ {msg}</p>}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button type="submit" style={{ background: C.accent, color: "#fff", border: "none", padding: "12px 22px", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
            {editId === null ? "Hinzufügen" : "Speichern"}
          </button>
          {editId !== null && (
            <button type="button" onClick={reset} style={{ background: "transparent", color: C.textSecondary, border: `1px solid ${C.border}`, padding: "12px 22px", borderRadius: 12, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Abbrechen</button>
          )}
        </div>
      </form>

      <h2 style={{ fontSize: 18, fontWeight: 650, color: C.textPrimary, margin: "0 0 16px" }}>
        Angelegte Antworten {faqs && faqs.length > 0 && <span style={{ color: C.textSecondary, fontWeight: 500 }}>({faqs.length})</span>}
      </h2>
      {faqs === null ? (
        <p style={{ color: C.textSecondary }}>Lädt…</p>
      ) : faqs.length === 0 ? (
        <p style={{ color: C.textSecondary }}>Noch keine eigenen Antworten hinterlegt.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {faqs.map((f) => (
            <div key={f.id} style={{ ...card, padding: 20, display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.textPrimary }}>{f.question}</div>
                <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 4, whiteSpace: "pre-wrap" }}>{f.answer}</div>
              </div>
              <button onClick={() => { setEditId(f.id); setQ(f.question); setA(f.answer); setMsg(""); setErr(""); }} style={{ flex: "0 0 auto", padding: "8px 12px", borderRadius: 8, border: `1px solid ${C.border}`, background: "#fff", color: C.textPrimary, cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Bearbeiten</button>
              <button onClick={() => remove(f.id)} style={{ flex: "0 0 auto", padding: "8px 12px", borderRadius: 8, border: "none", background: "oklch(0.55 0.18 25)", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Löschen</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Screen 4: Einbindung ---------- */
function Embed() {
  const [snippet, setSnippet] = useState("");
  const [active, setActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.snippet().then((s) => { setSnippet(s.snippet); setActive(s.widgetActive); }).catch((e) => setErr((e as Error).message));
  }, []);

  function copy() {
    if (navigator.clipboard) navigator.clipboard.writeText(snippet).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <h1 style={h1Style()}>Einbindung</h1>
      <p style={{ fontSize: 16, color: C.textSecondary, margin: "0 0 24px" }}>
        Füge diesen Code vor dem schließenden <span style={{ fontFamily: "ui-monospace, monospace" }}>&lt;/body&gt;</span>-Tag eurer Website ein.
      </p>
      {err && <p style={{ color: C.red }}>{err}</p>}
      {active && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: C.green, display: "inline-block" }} />
          <span style={{ fontSize: 14, color: "oklch(0.45 0.01 258)", fontWeight: 500 }}>Bereits eingebunden — wir erkennen aktiven Widget-Traffic</span>
        </div>
      )}
      <div style={{ position: "relative", background: "oklch(0.2 0.012 258)", borderRadius: 16, padding: 24, boxShadow: "0 8px 24px oklch(0.2 0.01 258 / 0.12)" }}>
        <button onClick={copy} style={{ position: "absolute", top: 18, right: 18, background: copied ? C.green : "oklch(0.32 0.01 258)", color: "#fff", border: "none", borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>{copied ? "Kopiert ✓" : "Kopieren"}</button>
        <pre style={{ margin: 0, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, lineHeight: 1.7, color: "oklch(0.9 0.01 258)", whiteSpace: "pre-wrap", wordBreak: "break-word", paddingRight: 90 }}>{snippet}</pre>
      </div>
      <p style={{ margin: "20px 4px 0", fontSize: 13, color: "oklch(0.55 0.01 258)" }}>Fragen zur Einbindung? Schreib uns über den Support-Chat.</p>
    </div>
  );
}
