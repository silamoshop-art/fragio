import { useEffect, useState } from "react";
import { api, recrawl, openInvoicePdf, type Analytics, type Bot, type ChatLogEntry, type Invoice, type ManualFaq, type PlanRequest } from "./api";

// Unter-Tabs pro Bot, damit nicht alles auf einer langen Seite steht.
const BOT_TABS: [string, string][] = [
  ["config", "Einstellungen"],
  ["widget", "Widget & Einbindung"],
  ["faqs", "FAQ-Antworten"],
  ["billing", "Abrechnung"],
  ["privacy", "Datenschutz"],
  ["analytics", "Analytics"],
];

export function BotDetail({ botId, onDeleted }: { botId: string; onDeleted: () => void }) {
  const [bot, setBot] = useState<Bot | null>(null);
  const [tab, setTab] = useState("config");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [snippet, setSnippet] = useState("");
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [msg, setMsg] = useState("");
  const [crawlMsg, setCrawlMsg] = useState("");
  const [invoiceMsg, setInvoiceMsg] = useState("");
  const [chatLogs, setChatLogs] = useState<ChatLogEntry[] | null>(null);
  const [exAmount, setExAmount] = useState("");
  const [exDesc, setExDesc] = useState("");
  const [exPeriod, setExPeriod] = useState("");
  const [portalEmail, setPortalEmail] = useState("");
  const [portalPw, setPortalPw] = useState("");
  const [portalMsg, setPortalMsg] = useState("");
  const [planRequests, setPlanRequests] = useState<PlanRequest[]>([]);
  const [stripeEnabled, setStripeEnabled] = useState(false);
  const [reqMsg, setReqMsg] = useState("");

  async function load() {
    const [b, a, s, inv, reqs] = await Promise.all([
      api.getBot(botId),
      api.analytics(botId),
      api.snippet(botId),
      api.listInvoices(botId),
      api.planRequests(),
    ]);
    setBot(b);
    setAnalytics(a);
    setSnippet(s.snippet);
    setInvoices(inv);
    setPlanRequests(reqs.filter((r) => r.botId === botId));
  }
  useEffect(() => {
    load().catch((e) => setMsg((e as Error).message));
    api.me().then((m) => setStripeEnabled(m.stripeEnabled)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  async function resolveRequest(id: number) {
    setReqMsg("");
    try {
      const r = await api.resolvePlanRequest(id);
      if (r.invoice) {
        setReqMsg(`✓ Freigeschaltet & Rechnung ${r.invoice.invoiceNumber} erstellt — siehe „Zahlungen“ › Offene Zahlungen.`);
      } else if (r.invoiceError) {
        setReqMsg(`✓ Freigeschaltet, aber KEINE Rechnung erstellt: ${r.invoiceError}`);
      } else {
        setReqMsg("✓ Tarif freigeschaltet & Anfrage erledigt.");
      }
      await load();
    } catch (e) {
      setReqMsg("⚠️ " + (e as Error).message);
    }
  }

  if (!bot) return <div className="panel">Lädt…</div>;

  async function save(patch: Record<string, unknown>) {
    setMsg("");
    try {
      const updated = await api.updateBot(botId, patch);
      setBot(updated);
      setMsg("Gespeichert ✓");
      setTimeout(() => setMsg(""), 2000);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  function doRecrawl() {
    setCrawlMsg("Starte…");
    recrawl(botId, {
      progress: (p) =>
        setCrawlMsg(
          p.phase === "crawling"
            ? `🕷 ${p.fetched} Seiten…`
            : p.phase === "indexing"
              ? `📚 ${p.chunks} Textblöcke…`
              : "…",
        ),
      ready: (r) => {
        setCrawlMsg(`✓ ${r.pages} Seiten, ${r.chunks} Textblöcke`);
        load();
      },
      error: (m) => setCrawlMsg("⚠️ " + m),
    });
  }

  async function doDelete() {
    if (
      !confirm(
        `Bot "${bot!.name}" wirklich vollständig löschen?\n\n` +
          `Alle Daten werden entfernt: Wissensbasis, Chat-Logs, Rechnungen, Logo, Portal-Login.\n` +
          `Das kann NICHT rückgängig gemacht werden.`,
      )
    )
      return;
    try {
      await api.deleteBot(botId);
      onDeleted();
    } catch (e) {
      setMsg("⚠️ Löschen fehlgeschlagen: " + (e as Error).message);
    }
  }


  async function createInvoice() {
    setInvoiceMsg("Erstelle Rechnung…");
    try {
      const r = await api.createInvoice(botId);
      setInvoiceMsg(r.created ? `✓ Rechnung ${r.invoice?.invoiceNumber} erstellt` : "Für diesen Zeitraum existiert bereits eine Rechnung.");
      setInvoices(await api.listInvoices(botId));
    } catch (e) {
      setInvoiceMsg("⚠️ " + (e as Error).message);
    }
  }

  async function fillProration() {
    try {
      const p = await api.proration(botId);
      setExAmount((p.cents / 100).toFixed(2));
      setExDesc(`Anteilige Nutzung (${p.remainingDays} von ${p.daysInMonth} Tagen)`);
      setExPeriod("laufender Monat (anteilig)");
    } catch (e) {
      setInvoiceMsg("⚠️ " + (e as Error).message);
    }
  }

  async function createExtra() {
    const cents = Math.round(parseFloat(exAmount.replace(",", ".")) * 100);
    if (!cents || cents <= 0 || !exDesc.trim()) { setInvoiceMsg("Betrag + Beschreibung nötig."); return; }
    setInvoiceMsg("Erstelle Zusatzrechnung…");
    try {
      const r = await api.createExtraInvoice(botId, { amountCents: cents, description: exDesc, periodLabel: exPeriod || undefined });
      setInvoiceMsg(`✓ Zusatzrechnung ${r.invoice?.invoiceNumber} erstellt`);
      setExAmount(""); setExDesc(""); setExPeriod("");
      setInvoices(await api.listInvoices(botId));
    } catch (e) {
      setInvoiceMsg("⚠️ " + (e as Error).message);
    }
  }

  async function loadChatLogs() {
    try {
      setChatLogs(await api.chatLogs(botId));
    } catch (e) {
      setMsg("⚠️ " + (e as Error).message);
    }
  }
  async function deleteSender(ipHash: string) {
    if (!confirm("Alle Chat-Anfragen dieses Absenders (gleicher IP-Hash) unwiderruflich löschen?")) return;
    try {
      const r = await api.deleteBySender(botId, ipHash);
      setMsg(`✓ ${r.deleted} Eintrag/Einträge gelöscht.`);
      await loadChatLogs();
    } catch (e) {
      setMsg("⚠️ " + (e as Error).message);
    }
  }

  async function setPortalLogin() {
    setPortalMsg("");
    if (!portalEmail.trim()) { setPortalMsg("Bitte E-Mail eingeben."); return; }
    try {
      const r = await api.setPortalUser(botId, {
        email: portalEmail.trim(),
        password: portalPw.trim() || undefined,
      });
      const pwNote = r.password ? ` · generiertes Passwort: ${r.password}` : " · Passwort gesetzt";
      setPortalMsg(`✓ Login für ${r.email} aktiv${pwNote}`);
      setPortalPw("");
      await load();
    } catch (e) {
      setPortalMsg("⚠️ " + (e as Error).message);
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>
          {bot.name}{" "}
          {bot.status !== "active" && <span className="tag warn">{bot.status}</span>}
        </h2>
        <div className="head-actions">
          <button
            className="btn ghost sm"
            onClick={() => save({ status: bot.status === "active" ? "paused" : "active" })}
          >
            {bot.status === "active" ? "Pausieren" : "Aktivieren"}
          </button>
          <button className="btn danger sm" onClick={doDelete}>Löschen</button>
        </div>
      </div>
      {msg && <p className="note">{msg}</p>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0 6px", borderBottom: "1px solid var(--line)", paddingBottom: 10 }}>
        {BOT_TABS.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              border: "none", cursor: "pointer", borderRadius: 10, padding: "8px 14px", fontSize: 14, fontWeight: 600,
              background: tab === id ? "var(--accent-soft-bg)" : "transparent",
              color: tab === id ? "var(--accent-soft-text)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "config" && (<>
      <Section title="Limits & Kontingent">
        <UsageBar used={bot.usage.used} quota={bot.usage.quota} />
        <Field label="Monatskontingent">
          <input type="number" defaultValue={bot.monthlyQuota} onBlur={(e) => save({ monthlyQuota: Number(e.target.value) })} />
        </Field>
        <Field label="Max. Zeichen / Frage">
          <input type="number" defaultValue={bot.maxInputChars} onBlur={(e) => save({ maxInputChars: Number(e.target.value) })} />
        </Field>
        <Field label="Max. Antwort-Tokens">
          <input type="number" defaultValue={bot.maxAnswerTokens} onBlur={(e) => save({ maxAnswerTokens: Number(e.target.value) })} />
        </Field>
        <Field label="Limit-Nachricht">
          <input defaultValue={bot.limitMessage || ""} placeholder="Standardtext bei erreichtem Limit" onBlur={(e) => save({ limitMessage: e.target.value || null })} />
        </Field>
      </Section>

      {bot.trialMode && bot.trialExpiresAt && (
        <div className="trial-banner">
          ⏳ Trial – läuft ab am {new Date(bot.trialExpiresAt).toLocaleDateString()} ·
          {" "}{bot.trialRequestCount}/{bot.trialRequestCap} Anfragen genutzt
          <button className="btn sm" onClick={() => save({ trialMode: false })}>Jetzt upgraden</button>
        </div>
      )}

      <Section title="Wissensbasis">
        <p className="muted">
          {bot.chunkCount} Textblöcke ·{" "}
          {bot.lastCrawledAt ? "zuletzt " + new Date(bot.lastCrawledAt).toLocaleString() : "noch nie gecrawlt"}
          {bot.lastCrawlStatus === "ok" && " · ✅ erfolgreich"}
          {bot.lastCrawlStatus === "error" && (
            <span className="crawl-err"> · ❌ fehlgeschlagen: {bot.lastCrawlError}</span>
          )}
        </p>
        <Field label="Start-URL">
          <input defaultValue={bot.crawlStartUrl || ""} onBlur={(e) => save({ crawlStartUrl: e.target.value })} placeholder="https://…" />
        </Field>
        <Field label="Max. Seiten">
          <input type="number" defaultValue={bot.crawlMaxPages} onBlur={(e) => save({ crawlMaxPages: Number(e.target.value) })} />
        </Field>
        <button className="btn" onClick={doRecrawl}>Neu crawlen</button>
        {crawlMsg && <span className="note inline">{crawlMsg}</span>}
      </Section>

      <Section title="KI-Engine">
        <Field label="Modus">
          <select value={bot.llmProvider} onChange={(e) => save({ llmProvider: e.target.value })}>
            <option value="local">Standard (Claude Haiku 4.5)</option>
            <option value="ollama">Lokal (Ollama) — Datenschutz-Premium</option>
            <option value="anthropic">Anthropic (eigener API-Key)</option>
            <option value="openai">OpenAI (eigener API-Key)</option>
          </select>
        </Field>
        {bot.llmProvider === "ollama" && (
          <p className="warn-box">
            🔒 Läuft komplett auf dem Server — <strong>keine Chat-Anfragen an Anthropic / keine
            US-Übermittlung</strong>. Höhere Antwortzeit, dafür volle Datenverarbeitung in
            Eigenregie. (Als Aufpreis-Tarif vermarktbar.)
          </p>
        )}
        {(bot.llmProvider === "anthropic" || bot.llmProvider === "openai") && (
          <>
            <Field label={`API-Key ${bot.hasApiKey ? "(hinterlegt ✓)" : "(fehlt)"}`}>
              <input type="password" placeholder="Key eingeben zum Setzen/Ändern" onBlur={(e) => e.target.value && save({ apiKey: e.target.value })} />
            </Field>
            <Field label="Modell (optional)">
              <input defaultValue={bot.chatModel || ""} placeholder="Provider-Standard" onBlur={(e) => save({ chatModel: e.target.value || null })} />
            </Field>
            <label className="check">
              <input type="checkbox" defaultChecked={bot.fallbackToLocal} onChange={(e) => save({ fallbackToLocal: e.target.checked })} />
              Bei API-Ausfall auf Standard-Engine zurückfallen
            </label>
          </>
        )}
      </Section>
      </>)}

      {tab === "widget" && (<>
      <Section title="Widget-Design">
        <Field label="Bot-Name"><input defaultValue={bot.branding.botName || ""} onBlur={(e) => save({ branding: { ...bot.branding, botName: e.target.value } })} /></Field>
        <Field label="Farbe"><input type="color" defaultValue={bot.branding.primaryColor || "#4f46e5"} onBlur={(e) => save({ branding: { ...bot.branding, primaryColor: e.target.value } })} /></Field>
        <Field label="Begrüßung"><input defaultValue={bot.branding.greeting || ""} onBlur={(e) => save({ branding: { ...bot.branding, greeting: e.target.value } })} /></Field>
        <Field label="Logo-URL"><input defaultValue={bot.branding.logoUrl || ""} onBlur={(e) => save({ branding: { ...bot.branding, logoUrl: e.target.value } })} placeholder="https://…/logo.png" /></Field>
      </Section>

      <Section title="Erlaubte Domain (CORS)">
        {bot.allowedOrigins.length === 0 && (
          <p className="warn-box">
            ⚠️ Keine Domain gesetzt — der Bot kann derzeit von <strong>jeder</strong> Website
            eingebunden werden. Für Produktion die echte Domain eintragen.
          </p>
        )}
        <Field label="Domain">
          <input
            defaultValue={bot.allowedOrigins[0] || ""}
            placeholder="firma.at"
            onBlur={(e) => save({ domain: e.target.value.trim() })}
          />
        </Field>
        <p className="muted">Genau eine Domain pro Bot. Leer = überall erlaubt (nur für Tests).</p>
      </Section>

      <Section title="Vorschau für den Kunden">
        <p className="muted">
          Diesen Link an den Kunden schicken — er testet seinen (bereits befüllten) Bot ohne Login:
        </p>
        <code className="snippet">{bot.previewUrl}</code>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(bot.previewUrl)}>Link kopieren</button>
        <a className="btn sm ghost" href={bot.previewUrl} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>Öffnen</a>
      </Section>

      <Section title="Kunden-Login (Portal)">
        <p className="muted">
          Eigener Login für den Kunden — sieht im Portal <strong>nur diesen Bot</strong> (Verbrauch,
          Tarife, Fragen, Snippet).{" "}
          {bot.portalUser ? <>Aktiv für: <strong>{bot.portalUser}</strong></> : "Noch kein Login."}
        </p>
        <Field label="Kunden-E-Mail">
          <input type="email" value={portalEmail} placeholder={bot.portalUser || "kunde@firma.at"} onChange={(e) => setPortalEmail(e.target.value)} />
        </Field>
        <Field label="Passwort (optional)">
          <input type="text" value={portalPw} placeholder="leer = wird generiert (min. 8 Zeichen)" onChange={(e) => setPortalPw(e.target.value)} />
        </Field>
        <button className="btn sm" onClick={setPortalLogin}>{bot.portalUser ? "Login zurücksetzen" : "Login anlegen"}</button>
        <a className="btn sm ghost" href={bot.portalUrl} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>Portal öffnen</a>
        {portalMsg && <p className="note">{portalMsg}</p>}
      </Section>

      <Section title="Einbetten (Snippet für die Website)">
        <code className="snippet">{snippet}</code>
        <button className="btn sm" onClick={() => navigator.clipboard.writeText(snippet)}>Kopieren</button>
      </Section>
      </>)}

      {tab === "faqs" && <FaqSection botId={botId} />}

      {tab === "billing" && (<>
      <Section title="Tarif-Anfragen (aus dem Portal)">
        <p className="muted">
          Zahlungsablauf: <strong>{stripeEnabled ? "Stripe aktiv" : "manuell (Stripe aus)"}</strong>.
          {stripeEnabled
            ? " Tarifklicks starten Stripe-Checkout; Freischaltung erfolgt automatisch nach Zahlung."
            : " Kunden-Tarifklicks landen als Anfrage hier. Rechnung verschicken, dann freischalten."}
        </p>
        {reqMsg && <p className="note">{reqMsg}</p>}
        {planRequests.filter((r) => r.status === "open").length === 0 && (
          <p className="muted">Keine offenen Anfragen.</p>
        )}
        <ul className="qlist">
          {planRequests.map((r) => (
            <li key={r.id}>
              <span className="badge">{r.status === "open" ? "offen" : "erledigt"}</span>{" "}
              <strong>{r.planName}</strong> ·{" "}
              {r.variant === "setup"
                ? `${r.monthlyCents / 100} €/Mon + ${r.setupCents / 100} € Einrichtung`
                : `${r.monthlyCents / 100} €/Mon · ${r.commitmentMonths} Mon. Bindung`}{" "}
              · {new Date(r.createdAt).toLocaleDateString()}
              {r.status === "open" && (
                <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => resolveRequest(r.id)}>
                  Tarif freischalten &amp; erledigt
                </button>
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Abrechnung">
        <Field label="Tarif">
          <input defaultValue={bot.plan || ""} placeholder="Starter / Business / Pro" onBlur={(e) => save({ plan: e.target.value || null })} />
        </Field>
        <Field label="Preis / Monat (€)">
          <input
            type="number"
            step="0.01"
            defaultValue={(bot.priceCents / 100).toFixed(2)}
            onBlur={(e) => save({ priceCents: Math.round(parseFloat(e.target.value || "0") * 100) })}
          />
        </Field>
        <label className="check">
          <input type="checkbox" defaultChecked={bot.isPaying} onChange={(e) => save({ isPaying: e.target.checked })} />
          Zahlender Kunde (bekommt monatlich automatisch eine Rechnung)
        </label>
        <label className="check">
          <input type="checkbox" defaultChecked={bot.autoSendInvoice} onChange={(e) => save({ autoSendInvoice: e.target.checked })} />
          Rechnung automatisch per E-Mail an Kunde senden
        </label>

        <h4>Individueller Rabatt <span className="muted">(nur für diesen Kunden)</span></h4>
        <Field label="Rabatt-Art">
          <select
            value={bot.discountType || ""}
            onChange={(e) => save({ discountType: (e.target.value || null) as "percent" | "fixed" | null })}
          >
            <option value="">Kein Rabatt</option>
            <option value="percent">Prozent (%)</option>
            <option value="fixed">Fixbetrag (€)</option>
          </select>
        </Field>
        {bot.discountType && (
          <Field label={bot.discountType === "percent" ? "Rabatt (%)" : "Rabatt (€)"}>
            <input
              type="number"
              step={bot.discountType === "percent" ? "1" : "0.01"}
              defaultValue={bot.discountType === "percent" ? bot.discountValue : (bot.discountValue / 100).toFixed(2)}
              onBlur={(e) =>
                save({
                  discountValue:
                    bot.discountType === "percent"
                      ? Math.round(parseFloat(e.target.value || "0"))
                      : Math.round(parseFloat(e.target.value || "0") * 100),
                })
              }
            />
          </Field>
        )}
        {bot.discountType && (
          <p className="muted">
            Basispreis {(bot.basePriceCents / 100).toFixed(2)} € → berechneter Preis{" "}
            <strong>{(bot.priceCents / 100).toFixed(2)} €</strong>
          </p>
        )}

        <h4>Rechnungsdaten des Kunden <span className="muted">(nur für DIESEN Bot)</span></h4>
        {(!bot.customerName || !bot.customerAddress) && (
          <p className="warn-box">⚠️ Name/Adresse fehlen — für diesen zahlenden Bot kann sonst keine Rechnung erstellt werden.</p>
        )}
        <Field label="Firma / Name"><input defaultValue={bot.customerName || ""} onBlur={(e) => save({ customerName: e.target.value.trim() || null })} /></Field>
        <Field label="Adresse"><input defaultValue={bot.customerAddress || ""} placeholder="Straße, PLZ Ort" onBlur={(e) => save({ customerAddress: e.target.value.trim() || null })} /></Field>
        <Field label="Rechnungs-E-Mail"><input defaultValue={bot.customerEmail || ""} placeholder="kunde@firma.at" onBlur={(e) => save({ customerEmail: e.target.value.trim() })} /></Field>
        <Field label="UID (optional)"><input defaultValue={bot.customerVat || ""} onBlur={(e) => save({ customerVat: e.target.value.trim() || null })} /></Field>

        <h4>Rechnungshistorie</h4>
        <button className="btn sm" onClick={createInvoice}>Rechnung für kommenden Monat erstellen</button>
        <span className="muted" style={{ marginLeft: 8 }}>Vorauskasse — Abo wird vorab berechnet.</span>
        {invoiceMsg && <p className="note">{invoiceMsg}</p>}
        {invoices.length ? (
          <ul className="qlist">
            {invoices.map((inv) => (
              <li key={inv.id}>
                <button className="linklike" onClick={() => openInvoicePdf(inv.id).catch((e) => setInvoiceMsg((e as Error).message))}>
                  {inv.invoiceNumber}
                </button>{" "}
                · {inv.periodLabel} · {(inv.amountCents / 100).toFixed(2)} {inv.currency}
                {inv.sent && " · ✉️ versendet"}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Noch keine Rechnungen.</p>
        )}

        <h4>Zusatzrechnung erstellen <span className="muted">(Proration, Sonderposten)</span></h4>
        <Field label="Betrag (€)">
          <input type="number" step="0.01" value={exAmount} placeholder="z. B. 64,50"
            onChange={(e) => setExAmount(e.target.value)} />
        </Field>
        <Field label="Beschreibung">
          <input value={exDesc} placeholder="z. B. Tarif-Upgrade anteilig"
            onChange={(e) => setExDesc(e.target.value)} />
        </Field>
        <Field label="Zeitraum (Text)">
          <input value={exPeriod} placeholder="z. B. Juli 2026 (anteilig)"
            onChange={(e) => setExPeriod(e.target.value)} />
        </Field>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button className="btn ghost sm" onClick={fillProration}>Anteilig berechnen (Rest des Monats)</button>
          <button className="btn sm" onClick={createExtra}>Zusatzrechnung erstellen</button>
        </div>
      </Section>
      </>)}

      {tab === "privacy" && (<>
      <Section title="Datenschutz (Consent-Popup)">
        <p className="muted">
          Text der Datenschutz-Unterseite, die im Einwilligungs-Popup des Chat-Widgets verlinkt
          ist. Leer lassen = automatische DSGVO-Vorlage (inkl. Hinweis auf Drittland-Übermittlung
          an Anthropic/USA).
        </p>
        <Field label="Datenschutztext">
          <textarea
            rows={14}
            defaultValue={bot.privacyText || ""}
            placeholder="Leer = Standard-Vorlage wird verwendet"
            onBlur={(e) => save({ privacyText: e.target.value.trim() ? e.target.value : null })}
          />
        </Field>
        <p className="muted">
          <a href={`/privacy.html?bot=${bot.id}`} target="_blank" rel="noopener noreferrer">
            Datenschutzseite ansehen ↗
          </a>
        </p>
        <p className="muted">
          Einwilligungs-Nachweis (anonym): <strong>{bot.consent.count}</strong> Zustimmung(en)
          {bot.consent.lastAt ? `, zuletzt ${new Date(bot.consent.lastAt).toLocaleString("de-AT")}` : ""}
        </p>

        <h4>Speicherdauer der Chat-Verläufe</h4>
        <Field label="Automatisch löschen nach">
          <select defaultValue={bot.retentionDays} onChange={(e) => save({ retentionDays: Number(e.target.value) })}>
            <option value={30}>30 Tagen</option>
            <option value={90}>90 Tagen</option>
            <option value={180}>180 Tagen</option>
            <option value={365}>365 Tagen</option>
          </select>
        </Field>
        <p className="muted">Ein täglicher Job löscht Chat-Verläufe, die älter sind. Wird auch auf der Datenschutzseite angezeigt.</p>

        <h4>Chat-Verläufe & Löschanspruch (Art. 17 DSGVO)</h4>
        <p className="muted">Absender werden nur als <strong>gehashte IP</strong> angezeigt (keine Klartext-IP). „Löschen" entfernt alle Anfragen desselben Absenders.</p>
        {chatLogs === null ? (
          <button className="btn ghost sm" onClick={loadChatLogs}>Chat-Verläufe laden</button>
        ) : chatLogs.length === 0 ? (
          <p className="muted">Keine gespeicherten Chat-Verläufe (nur mit „Annehmen" wird gespeichert).</p>
        ) : (
          <table className="tbl">
            <thead><tr><th>Zeit</th><th>Frage</th><th>IP-Hash</th><th></th></tr></thead>
            <tbody>
              {chatLogs.map((l) => (
                <tr key={l.id}>
                  <td className="muted" style={{ whiteSpace: "nowrap" }}>{new Date(l.createdAt).toLocaleString("de-AT")}</td>
                  <td>{l.question.slice(0, 60)}{!l.answered && <span className="tag warn" style={{ marginLeft: 6 }}>unbeantwortet</span>}</td>
                  <td style={{ fontFamily: "ui-monospace, monospace", fontSize: 12 }}>{l.ipHash ? l.ipHash.slice(0, 12) + "…" : "—"}</td>
                  <td>{l.ipHash && <button className="btn danger sm" onClick={() => deleteSender(l.ipHash!)}>Absender löschen</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      </>)}

      {tab === "analytics" && (
        analytics ? (
        <Section title="Analytics">
          <div className="stats">
            <Stat label="Fragen" value={analytics.total} />
            <Stat label="Beantwortet" value={analytics.answered} />
            <Stat label="Unbeantwortet" value={analytics.unanswered} />
          </div>
          <h4>Häufigste Fragen</h4>
          {analytics.topQuestions.length ? (
            <ul className="qlist">{analytics.topQuestions.map((q, i) => <li key={i}><span className="badge">{q.count}×</span> {q.question}</li>)}</ul>
          ) : <p className="muted">Noch keine Daten.</p>}
          <h4>Unbeantwortete Fragen <span className="muted">(Content-Lücken!)</span></h4>
          {analytics.recentUnanswered.length ? (
            <ul className="qlist">{analytics.recentUnanswered.map((q, i) => <li key={i}>{q.question}</li>)}</ul>
          ) : <p className="muted">Keine — super!</p>}
        </Section>
        ) : (
          <p className="muted">Noch keine Analytics-Daten.</p>
        )
      )}
    </div>
  );
}

/**
 * Verwaltung manueller FAQ-Antworten (Prompt 14 #5). Recrawl-fest (eigene Tabelle).
 * Bei sehr starker Übereinstimmung gibt der Bot die hinterlegte Antwort wörtlich aus.
 */
function FaqSection({ botId }: { botId: string }) {
  const [faqs, setFaqs] = useState<ManualFaq[] | null>(null);
  const [q, setQ] = useState("");
  const [a, setA] = useState("");
  const [msg, setMsg] = useState("");
  const [editId, setEditId] = useState<number | null>(null);

  async function load() {
    try {
      setFaqs(await api.listFaqs(botId));
    } catch (e) {
      setMsg("⚠️ " + (e as Error).message);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);

  function reset() {
    setQ("");
    setA("");
    setEditId(null);
  }

  async function submit() {
    if (q.trim().length < 2 || !a.trim()) {
      setMsg("Frage (min. 2 Zeichen) und Antwort nötig.");
      return;
    }
    setMsg("Speichere…");
    try {
      if (editId === null) {
        await api.createFaq(botId, { question: q.trim(), answer: a.trim() });
        setMsg("✓ FAQ hinzugefügt");
      } else {
        await api.updateFaq(botId, editId, { question: q.trim(), answer: a.trim() });
        setMsg("✓ FAQ aktualisiert");
      }
      reset();
      await load();
    } catch (e) {
      setMsg("⚠️ " + (e as Error).message);
    }
  }

  async function remove(id: number) {
    if (!confirm("Diese FAQ-Antwort löschen?")) return;
    try {
      await api.deleteFaq(botId, id);
      if (editId === id) reset();
      await load();
    } catch (e) {
      setMsg("⚠️ " + (e as Error).message);
    }
  }

  function startEdit(f: ManualFaq) {
    setEditId(f.id);
    setQ(f.question);
    setA(f.answer);
    setMsg("");
  }

  return (
    <Section title="Manuelle FAQ-Antworten">
      <p className="muted">
        Redaktionelle Frage/Antwort-Paare für häufige Fragen oder eine bestimmte
        gewünschte Formulierung. Sie werden <strong>vorrangig</strong> zur normalen
        Suche berücksichtigt und überstehen jeden <strong>Neu-Crawl</strong> (eigene
        Datenablage). Bei sehr starker Übereinstimmung gibt der Bot die hinterlegte
        Antwort wörtlich aus. Tipp: als „Frage" die typische Formulierung des Besuchers
        eintragen; bei mehreren Varianten mehrere FAQs anlegen.
      </p>

      <Field label={editId === null ? "Frage / Trigger-Formulierung" : "Frage bearbeiten"}>
        <input value={q} placeholder="z. B. Bietet ihr kostenlose Parkplätze?" onChange={(e) => setQ(e.target.value)} />
      </Field>
      <Field label="Gewünschte Antwort">
        <textarea rows={4} value={a} placeholder="Die Antwort, die der Bot geben soll…" onChange={(e) => setA(e.target.value)} />
      </Field>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn sm" onClick={submit}>{editId === null ? "FAQ hinzufügen" : "Änderung speichern"}</button>
        {editId !== null && <button className="btn ghost sm" onClick={reset}>Abbrechen</button>}
      </div>
      {msg && <p className="note">{msg}</p>}

      <h4>Angelegte FAQs {faqs && faqs.length > 0 && <span className="muted">({faqs.length})</span>}</h4>
      {faqs === null ? (
        <p className="muted">Lädt…</p>
      ) : faqs.length === 0 ? (
        <p className="muted">Noch keine manuellen FAQ-Antworten.</p>
      ) : (
        <ul className="qlist">
          {faqs.map((f) => (
            <li key={f.id}>
              <div style={{ flex: 1 }}>
                <strong>{f.question}</strong>
                <div className="muted" style={{ whiteSpace: "pre-wrap" }}>{f.answer}</div>
              </div>
              <button className="btn ghost sm" style={{ marginLeft: 8 }} onClick={() => startEdit(f)}>Bearbeiten</button>
              <button className="btn danger sm" style={{ marginLeft: 6 }} onClick={() => remove(f.id)}>Löschen</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sec">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="statv">{value}</div>
      <div className="statl">{label}</div>
    </div>
  );
}
function UsageBar({ used, quota }: { used: number; quota: number }) {
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const warn = pct >= 80;
  return (
    <div className="usage">
      <div className="usage-head">
        <span>{used} / {quota} Anfragen diesen Monat</span>
        {warn && <span className="usage-warn">⚠️ {pct}% ausgelastet</span>}
      </div>
      <div className="ubar">
        <i style={{ width: pct + "%", background: warn ? "#e11d48" : undefined }} />
      </div>
    </div>
  );
}
