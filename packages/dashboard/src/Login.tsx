import { useState } from "react";
import { api, setKey } from "./api";

/** Einziger Betreiber-Login: Admin-Key eingeben (kein Registrieren, kein Multi-Admin). */
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [key, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      setKey(key.trim());
      await api.me(); // validiert den Admin-Key
      onAuthed();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>SiteBot</h1>
        <p className="muted">Betreiber-Login</p>
        <input
          type="password"
          placeholder="Admin-Key (ADMIN_API_KEY)"
          value={key}
          onChange={(e) => setKeyInput(e.target.value)}
          required
          autoFocus
        />
        {err && <p className="err">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? "…" : "Anmelden"}</button>
      </form>
    </div>
  );
}
