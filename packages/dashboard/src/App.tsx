import { useEffect, useState } from "react";
import { api, clearKey, getKey, type Bot } from "./api";
import { Login } from "./Login";
import { BotDetail } from "./BotDetail";
import { PricingSettings } from "./PricingSettings";
import { OpenPayments } from "./OpenPayments";

export function App() {
  const [authed, setAuthed] = useState<boolean>(false);
  const [checking, setChecking] = useState<boolean>(true);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    if (!getKey()) {
      setChecking(false);
      return;
    }
    api
      .me()
      .then((me) => {
        setEmail(me.email);
        setAuthed(true);
      })
      .catch(() => clearKey())
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="center">Lädt…</div>;
  if (!authed)
    return (
      <Login
        onAuthed={() => {
          api.me().then((me) => setEmail(me.email)).catch(() => {});
          setAuthed(true);
        }}
      />
    );

  return <Dashboard email={email} onLogout={() => { clearKey(); setAuthed(false); }} />;
}

function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"bots" | "pricing" | "payments">("bots");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    try {
      const list = await api.listBots();
      setBots(list);
      if (!selected && list.length) setSelected(list[0].id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    try {
      const bot = await api.createBot({ name, startUrl: url || undefined });
      setName("");
      setUrl("");
      setCreating(false);
      await load();
      setSelected(bot.id);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">SiteBot</div>
        <div className="me">{email}</div>
        <button className="btn sm block" onClick={() => setCreating((v) => !v)}>+ Neuer Bot</button>
        {creating && (
          <form className="createbox" onSubmit={create}>
            <input placeholder="Bot-Name" value={name} onChange={(e) => setName(e.target.value)} required />
            <input placeholder="Website-URL (optional)" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn sm">Anlegen</button>
          </form>
        )}
        {err && <p className="err">{err}</p>}
        <div className="navlabel">Bots</div>
        <nav className="botnav">
          {bots.map((b) => (
            <button key={b.id} className={"botitem" + (view === "bots" && selected === b.id ? " on" : "")} onClick={() => { setView("bots"); setSelected(b.id); }}>
              <span className="dot" style={{ background: b.branding.primaryColor || "#4f46e5" }} />
              <span className="bn">{b.name}</span>
              {b.trialMode && <span className="tag">Trial</span>}
              {b.status !== "active" && <span className="tag warn">{b.status}</span>}
            </button>
          ))}
          {!bots.length && <p className="muted">Noch keine Bots.</p>}
        </nav>
        <div className="navlabel">Verwaltung</div>
        <button className={"botitem" + (view === "payments" ? " on" : "")} onClick={() => setView("payments")}>💶 Zahlungen</button>
        <button className={"botitem" + (view === "pricing" ? " on" : "")} onClick={() => setView("pricing")}>⚙ Einstellungen</button>
        <button className="btn ghost sm block" onClick={onLogout}>Abmelden</button>
      </aside>
      <main className="content">
        {view === "payments" ? (
          <OpenPayments />
        ) : view === "pricing" ? (
          <PricingSettings />
        ) : selected ? (
          <BotDetail
            botId={selected}
            key={selected}
            onDeleted={() => {
              setSelected(null);
              load();
            }}
          />
        ) : (
          <div className="empty">Wähle links einen Bot oder lege einen neuen an.</div>
        )}
      </main>
    </div>
  );
}
