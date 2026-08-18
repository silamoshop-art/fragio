# SiteBot — Deployment

Zentrales Backend (Crawler, Vektor-DB, RAG, LLM-Provider) läuft auf **einem**
gemieteten Server. Antworten via **Claude Haiku 4.5** (Anthropic-Key); Embeddings
laufen lokal im Node-Prozess (kein Ollama). Auf den Kunden-Websites liegt nur das
Widget-Snippet.

## Schnellstart (Docker Compose)

Voraussetzung: Docker + Docker Compose auf dem Server.

```bash
git clone <repo> sitebot && cd sitebot

# Pflicht-Secret erzeugen (verschlüsselt Kunden-API-Keys, AES-256-GCM):
export APP_SECRET=$(openssl rand -hex 32)

# Pflicht: dein Anthropic-Key für die Standard-Engine (HARTES Budgetlimit setzen!)
export ANTHROPIC_API_KEY=sk-ant-...

# Optional: separater Trial-Key (sonst wird ANTHROPIC_API_KEY genutzt)
export TRIAL_ANTHROPIC_API_KEY=sk-ant-...

docker compose up -d --build
# Das Embedding-Modell lädt beim ersten Start automatisch (einmalig).
```

- Landing/Demo:   `http://<server>:3000/`
- Widget-Script:  `http://<server>:3000/widget/widget.js`
- Admin-Dashboard: `http://<server>:3000/admin/` (wenn Dashboard gebaut, s. u.)
- Health:         `http://<server>:3000/health`

> **TLS:** In Produktion einen Reverse-Proxy (Caddy/nginx/Traefik) mit HTTPS
> davorschalten. Das Widget lädt sonst nicht auf `https://`-Kundenseiten
> (Mixed-Content). Das Backend läuft mit `trustProxy` für korrekte Client-IPs.

## Dashboard bauen (für /admin)

```bash
npm install
npm --workspace @sitebot/dashboard run build   # erzeugt packages/dashboard/dist
```
Ist `packages/dashboard/dist/index.html` vorhanden, serviert das Backend es unter
`/admin/`. Da Dashboard und API dieselbe Origin haben, funktioniert der relative
`/api`-Pfad ohne CORS. Alternativ getrennt hosten (Vercel/Netlify) und `/api`
per Proxy auf das Backend leiten.

## Umgebungsvariablen

| Variable | Pflicht | Default | Zweck |
|---|---|---|---|
| `APP_SECRET` | **ja (prod)** | – | 32-Byte-Hex; verschlüsselt Kunden-API-Keys. Ohne ihn sind gespeicherte Keys nach Neustart unlesbar. |
| `PORT` / `HOST` | nein | `3000` / `0.0.0.0` | Bind-Adresse |
| `DATABASE_PATH` | nein | `./data/sitebot.sqlite` | SQLite-Datei (Volume!) |
| `ANTHROPIC_API_KEY` | **ja** | – | Operator-Key für die Standard-Engine (Haiku 4.5). **Hartes Budgetlimit setzen!** |
| `DEFAULT_ENGINE` | nein | `anthropic` | `anthropic` (Haiku 4.5) oder `ollama` (optionaler lokaler Chat) |
| `ANTHROPIC_DEFAULT_MODEL` | nein | `claude-haiku-4-5-20251001` | Standard-Chat-Modell |
| `EMBEDDING_MODEL` | nein | `Xenova/multilingual-e5-small` | lokales Embedding-Modell (In-Process) |
| `EMBEDDING_DIM` | nein | `384` | muss zum Embed-Modell passen (Auto-Reset bei Wechsel) |
| `TRIAL_ANTHROPIC_API_KEY` | nein | – | separater Trial-Key (sonst `ANTHROPIC_API_KEY`) |
| `OPENAI_DEFAULT_MODEL` | nein | `gpt-4o-mini` | Default für Bring-your-own-Key (OpenAI) |

Siehe [.env.example](.env.example).

## Server-Sizing

Da Antworten über die Anthropic-API laufen und Embeddings ein kleines lokales
ONNX-Modell nutzen, genügt ein **schlanker Server ohne GPU** (z. B. 2 vCPU /
2–4 GB RAM). Das Embedding-Modell (~120 MB) lädt einmalig beim ersten Start und
wird im Volume `sitebot_models` gecached.

Datenpersistenz: `sitebot_data` (SQLite) und `sitebot_models` (Embedding-Cache)
sind Named Volumes — beim Neustart bleiben Bots/Wissensbasis und Modell erhalten.

## Produktions-Checkliste

- [ ] `APP_SECRET` gesetzt (und sicher verwahrt; Rotation macht alte Keys unlesbar)
- [ ] HTTPS-Reverse-Proxy davor
- [ ] Trial-Key (falls genutzt) mit hartem Ausgabenlimit bei Anthropic
- [ ] Pro Bot die echten Kunden-Domains in `allowedOrigins` eintragen (nicht leer lassen)
- [ ] Backups des `sitebot_data`-Volumes
- [ ] Datenschutzerklärung (EU/AT): Nutzeranfragen werden ggf. an Hosted-LLMs übertragen

## Ohne Docker: pm2 (Auto-Restart)

Alternative zu Docker, wenn direkt auf dem Host gefahren wird — pm2 startet den
Server bei Absturz automatisch neu und wieder nach einem Server-Reboot:

```bash
npm install
npm --workspace @sitebot/backend run build      # erzeugt packages/backend/dist
npm i -g pm2
pm2 start ecosystem.config.cjs                   # startet + überwacht
pm2 save && pm2 startup                          # Autostart nach Reboot einrichten
pm2 logs sitebot-backend                         # Logs ansehen
```

Konfiguration: [ecosystem.config.cjs](ecosystem.config.cjs). Die `.env` im Repo-Root
wird automatisch geladen.

## HTTPS-Reverse-Proxy (Pflicht vor Kundeneinsatz)

Das Widget lädt auf `https://`-Kundenseiten nur, wenn das Backend selbst über HTTPS
erreichbar ist (sonst Mixed-Content-Block). Einfachste Variante ist **Caddy** (holt
automatisch ein Let's-Encrypt-Zertifikat). `/etc/caddy/Caddyfile`:

```
bot.deine-domain.at {
    reverse_proxy 127.0.0.1:3000
}
```

Dann `systemctl reload caddy`. Danach ist alles unter `https://bot.deine-domain.at/`
erreichbar; im Widget-Snippet diese HTTPS-URL verwenden. (nginx-Alternative: server-Block
mit `proxy_pass http://127.0.0.1:3000;` + certbot für das Zertifikat.)

## E-Mail-Versand (SMTP)

Rechnungen, Mahnungen und Support-Weiterleitungen werden nur echt verschickt, wenn
SMTP konfiguriert ist — sonst werden sie nur geloggt (Stub). In der `.env`:

| Variable | Beispiel | Zweck |
|---|---|---|
| `SMTP_HOST` | `smtp.mailbox.org` | SMTP-Server des Anbieters |
| `SMTP_PORT` | `587` | 587 (STARTTLS) oder 465 (`SMTP_SECURE=true`) |
| `SMTP_SECURE` | `false` | `true` nur bei Port 465 |
| `SMTP_USER` | `no-reply@deine-domain.at` | Postfach-Login |
| `SMTP_PASS` | `********` | Postfach-Passwort / App-Passwort |
| `SMTP_FROM` | `SiteBot <no-reply@deine-domain.at>` | Absenderadresse (optional) |

Funktioniert mit jedem Anbieter (eigenes Postfach, Mailbox.org, Gmail-App-Passwort,
oder Resend/Postmark per SMTP). Verbindung testen: siehe `GET /api/admin/smtp-test`.

## Widget auf Kundenseiten mit Content-Security-Policy (CSP)

Getestet: Auf einer Kundenseite mit **strikter CSP** (`default-src 'self'` ohne
`'unsafe-inline'`) lädt das Widget **nicht korrekt** — das Skript käme von fremder
Origin (geblockt durch `script-src`), und die Shadow-DOM-Styles werden inline gesetzt
(geblockt durch `style-src`). Das ist kein Bug, sondern erwartetes CSP-Verhalten und
betrifft alle eingebetteten Widgets (Intercom & Co. genauso).

Kunden mit CSP müssen deine Widget-Domain freigeben. Beispiel (Domain anpassen):

```
Content-Security-Policy:
  script-src  'self' https://bot.deine-domain.at;
  connect-src 'self' https://bot.deine-domain.at;
  style-src   'self' 'unsafe-inline';
  img-src     'self' https://bot.deine-domain.at data:;
```

Ohne CSP (die große Mehrheit kleiner Firmenseiten) lädt das Widget ohne weitere
Einstellungen. Style-Isolation via Shadow DOM ist verifiziert (Host-CSS schlägt nicht
durch, Widget-CSS nicht hinaus).

## Backups

Automatisch: täglicher SQLite-Snapshot per `VACUUM INTO` nach `data/backups/`
(Cron `BACKUP_CRON`, Standard 04:00; Aufbewahrung `BACKUP_KEEP_DAYS`, Standard 14 Tage).
Manuell: `npm --workspace @sitebot/backend run backup:now`.
Wiederherstellen: Server stoppen → gewünschte Datei aus `data/backups/` nach
`data/sitebot.sqlite` kopieren (alte `-wal`/`-shm` löschen) → Server starten.
Zusätzlich das `data/`-Verzeichnis extern sichern (z. B. rclone/Backblaze).

## Bekannte MVP-Grenzen

- SSRF-Schutz prüft Host-Literale, nicht DNS-Rebinding → Crawler idealerweise
  netzwerkisoliert betreiben (eigenes Docker-Netz ohne Zugriff aufs interne LAN).
- SQLite (node:sqlite) ist für viele Bots auf einem Server gut geeignet; bei sehr
  hoher Last auf Postgres + pgvector migrieren (Repo-Schicht kapselt das SQL).
