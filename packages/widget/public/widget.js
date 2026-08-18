/*
 * SiteBot Embeddable Widget — Schritt 6 (Shadow DOM, Styling, Branding, responsive).
 *
 * Einbindung:
 *   <script src="https://<backend>/widget/widget.js" data-bot-id="bot_xxx" async></script>
 *
 * Style-Isolation: das gesamte UI lebt in einem Shadow Root. Host-Website-CSS
 * kann nicht hineinlecken und Widget-CSS nicht hinaus. Keine externen
 * Abhängigkeiten. Branding (Farbe/Name/Begrüßung/Logo) kommt vom Backend.
 * Transparenzhinweis "KI-Chatbot" ist Pflicht und immer sichtbar.
 */
(function () {
  "use strict";

  var self =
    document.currentScript ||
    document.querySelector("script[data-bot-id][src*='widget.js']");
  if (!self) return console.error("[SiteBot] Script-Tag mit data-bot-id nicht gefunden.");
  var botId = self.getAttribute("data-bot-id");
  if (!botId) return console.error("[SiteBot] data-bot-id fehlt.");
  var apiBase = self.getAttribute("data-api-base") || "";
  if (!apiBase) {
    try { apiBase = new URL(self.src).origin; } catch (e) { apiBase = ""; }
  }

  // Doppel-Einbindung vermeiden.
  if (window.__sitebotLoaded && window.__sitebotLoaded[botId]) return;
  window.__sitebotLoaded = window.__sitebotLoaded || {};
  window.__sitebotLoaded[botId] = true;

  var cfg = {
    botName: "Website-Assistent",
    primaryColor: "#4f46e5",
    greeting: "Hallo! 👋 Frag mich etwas über diese Website.",
    logoUrl: "",
    aiNotice: "Dies ist ein KI-Chatbot. Antworten können Fehler enthalten.",
    status: "active",
    consentNotice:
      "Dies ist ein KI-Chatbot. Zur Beantwortung werden deine Nachrichten an einen " +
      "KI-Dienstleister (Anthropic, USA) übermittelt — das ist für die Nutzung des Chats " +
      "notwendig. Zusätzlich kannst du erlauben, dass wir den Gesprächsverlauf zur " +
      "Verbesserung und für Statistiken speichern. Details in der Datenschutzerklärung.",
    privacyUrl: "",
  };

  // ---- Einwilligung (DSGVO/EU-AI-Act) ----
  // Zwei Modi (branchenüblich): "Annehmen" (analytics=true, Gesprächsverlauf wird für
  // Statistiken gespeichert) ODER "Nur notwendige Verarbeitung" (analytics=false, Chat
  // funktioniert normal, aber KEINE Speicherung des Inhalts). Gespeichert wird lokal nur
  // ein Flag {analytics, ts}. analyticsConsent steuert das storeContent-Feld je Anfrage.
  var CONSENT_KEY = "sitebot_consent_" + botId;
  var analyticsConsent = false;
  function getConsent() {
    try {
      var raw = localStorage.getItem(CONSENT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function hasConsent() {
    return !!getConsent();
  }
  function setConsent(analytics) {
    analyticsConsent = !!analytics;
    try {
      localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: 2, ts: Date.now(), analytics: analyticsConsent }));
    } catch (e) {}
  }
  // Beim Laden gespeicherte Wahl übernehmen (kein erneutes Popup in derselben Sitzung).
  (function () { var c = getConsent(); if (c) analyticsConsent = !!c.analytics; })();

  // Gesprächsverlauf (Prompt 15 #3) — nur clientseitig, damit kurze Folgefragen
  // ("nein größer") im Kontext verstanden werden. Wird pro Anfrage mitgeschickt
  // (nicht dauerhaft serverseitig gespeichert). Auf die letzten Turns begrenzt.
  var history = [];
  var HISTORY_MAX = 6;

  // ---- SSE-über-fetch Client ----
  function streamChat(message, on) {
    fetch(apiBase + "/api/chat/" + encodeURIComponent(botId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // storeContent nur true, wenn der Nutzer der Analytics-Speicherung zugestimmt hat.
      // history = bisherige Turns OHNE die aktuelle Nachricht.
      body: JSON.stringify({
        message: message,
        storeContent: analyticsConsent,
        history: history.slice(-HISTORY_MAX),
      }),
    })
      .then(function (res) {
        if (!res.ok || !res.body) return on.error("HTTP " + res.status);
        var reader = res.body.getReader(), dec = new TextDecoder(), buf = "";
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) return on.done();
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              var raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
              var ev = "message", data = "";
              raw.split("\n").forEach(function (line) {
                if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
                else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
              });
              var p = {};
              try { p = data ? JSON.parse(data) : {}; } catch (e) {}
              if (ev === "meta") on.meta(p);
              else if (ev === "token") on.token(p.t || "");
              else if (ev === "error") on.error(p.message || "Fehler");
            }
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) { on.error(String(e)); });
  }

  // ---- UI im Shadow DOM aufbauen ----
  function build() {
    var host = document.createElement("div");
    host.setAttribute("data-sitebot", botId);
    // Host selbst neutral halten; alles Weitere im Shadow Root.
    host.style.cssText = "all: initial;";
    var root = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    style.textContent = css(cfg.primaryColor);
    root.appendChild(style);

    var container = document.createElement("div");
    container.className = "sb-root";
    container.innerHTML = template(cfg);
    root.appendChild(container);
    document.body.appendChild(host);

    var launcher = root.querySelector(".sb-launcher");
    var panel = root.querySelector(".sb-panel");
    var closeBtn = root.querySelector(".sb-close");
    var log = root.querySelector(".sb-log");
    var form = root.querySelector(".sb-form");
    var input = root.querySelector(".sb-input");
    var consent = root.querySelector(".sb-consent");
    var acceptBtn = root.querySelector(".sb-consent-accept");
    var rejectBtn = root.querySelector(".sb-consent-reject");

    function open() {
      panel.classList.add("sb-open");
      launcher.setAttribute("aria-expanded", "true");
      setTimeout(function () { input.focus(); }, 50);
    }
    function close() {
      panel.classList.remove("sb-open");
      launcher.setAttribute("aria-expanded", "false");
    }
    function showConsent() { consent.classList.add("sb-open"); }
    function hideConsent() { consent.classList.remove("sb-open"); }

    launcher.addEventListener("click", function () {
      if (panel.classList.contains("sb-open")) return close();
      // Einwilligung ist Voraussetzung. Ohne Zustimmung erst das Popup zeigen;
      // der Chat bleibt inaktiv, bis „Annehmen“ geklickt wurde.
      if (!hasConsent()) return showConsent();
      open();
    });
    closeBtn.addEventListener("click", close);
    // „Annehmen“: volle Einwilligung -> Gesprächsverlauf wird für Statistiken gespeichert;
    // anonymen Consent-Nachweis melden. Chat öffnet normal.
    acceptBtn.addEventListener("click", function () {
      setConsent(true);
      try {
        fetch(apiBase + "/api/widget/" + encodeURIComponent(botId) + "/consent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          keepalive: true,
        }).catch(function () {});
      } catch (e) {}
      hideConsent();
      open();
    });
    // „Nur notwendige Verarbeitung“: Chat funktioniert GENAUSO normal (Anfrage geht an
    // Anthropic, da zur Diensterbringung nötig), ABER kein Speichern des Inhalts, kein
    // Consent-Event. Kein Blockieren des Chats mehr.
    rejectBtn.addEventListener("click", function () {
      setConsent(false);
      hideConsent();
      open();
    });

    function addMsg(role, text) {
      var row = document.createElement("div");
      row.className = "sb-msg sb-" + role;
      var bubble = document.createElement("div");
      bubble.className = "sb-bubble";
      bubble.textContent = text;
      row.appendChild(bubble);
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      return bubble;
    }
    function addSources(sources) {
      if (!sources || !sources.length) return;
      var row = document.createElement("div");
      row.className = "sb-sources";
      row.appendChild(document.createTextNode("Quellen: "));
      sources.forEach(function (s, i) {
        if (i > 0) row.appendChild(document.createTextNode(" · "));
        if (s.url) {
          var a = document.createElement("a");
          a.href = s.url; a.target = "_blank"; a.rel = "noopener noreferrer";
          a.textContent = s.title || s.url;
          row.appendChild(a);
        } else row.appendChild(document.createTextNode(s.title || "Quelle"));
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    // Begrüßung anzeigen.
    addMsg("bot", cfg.greeting);

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      input.value = "";
      addMsg("user", q);
      var bubble = addMsg("bot", "");
      bubble.classList.add("sb-typing");
      bubble.textContent = "…";
      var first = true, sources = null, acc = "";
      streamChat(q, {
        meta: function (m) { sources = m.sources; },
        token: function (t) {
          if (first) { bubble.classList.remove("sb-typing"); acc = ""; first = false; }
          acc += t;
          // Markdown (Links + **fett**) klickbar rendern statt als Rohtext.
          bubble.innerHTML = renderMarkdown(acc);
          log.scrollTop = log.scrollHeight;
        },
        error: function (msg) { bubble.classList.remove("sb-typing"); bubble.textContent = "⚠️ " + msg; },
        done: function () {
          if (first) { bubble.classList.remove("sb-typing"); bubble.textContent = "(keine Antwort)"; }
          addSources(sources);
          // Abgeschlossenen Austausch dem Verlauf hinzufügen (für Folgefragen).
          if (acc) {
            history.push({ role: "user", content: q });
            history.push({ role: "assistant", content: acc });
            if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
          }
        },
      });
    });
  }

  function template(c) {
    var logo = c.logoUrl
      ? '<img class="sb-logo" src="' + escapeAttr(c.logoUrl) + '" alt="" />'
      : '<span class="sb-logo sb-logo-fallback">🤖</span>';
    return (
      '<button class="sb-launcher" aria-label="Chat öffnen" aria-expanded="false">' +
      '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      "</button>" +
      '<section class="sb-panel" role="dialog" aria-label="Chat">' +
      '  <header class="sb-header">' +
      "    " + logo +
      '    <span class="sb-title">' + escapeHtml(c.botName) + "</span>" +
      '    <button class="sb-close" aria-label="Schließen">✕</button>' +
      "  </header>" +
      '  <div class="sb-log" aria-live="polite"></div>' +
      '  <div class="sb-notice">' + escapeHtml(c.aiNotice) + "</div>" +
      '  <form class="sb-form">' +
      '    <input class="sb-input" type="text" placeholder="Nachricht schreiben…" autocomplete="off" maxlength="2000" />' +
      '    <button class="sb-send" type="submit" aria-label="Senden">' +
      '      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
      "    </button>" +
      "  </form>" +
      "</section>" +
      '<section class="sb-consent" role="dialog" aria-modal="true" aria-label="Einwilligung">' +
      '  <div class="sb-consent-box">' +
      '    <h3 class="sb-consent-title">Hinweis zum KI-Chatbot</h3>' +
      '    <p class="sb-consent-text">' + escapeHtml(c.consentNotice) + "</p>" +
      '    <p class="sb-consent-privacy-wrap">' +
      '      <a class="sb-consent-privacy" href="' + escapeAttr(c.privacyUrl) +
      '" target="_blank" rel="noopener noreferrer">Datenschutzerklärung</a>' +
      "    </p>" +
      '    <div class="sb-consent-actions">' +
      '      <button class="sb-consent-accept" type="button">Annehmen — Verlauf für Statistiken speichern</button>' +
      '      <button class="sb-consent-reject" type="button">Nur notwendige Verarbeitung</button>' +
      "    </div>" +
      "  </div>" +
      "</section>"
    );
  }

  function css(brand) {
    return [
      ".sb-root{--sb-brand:" + brand + ";--sb-radius:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;}",
      ".sb-launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;width:56px;height:56px;border-radius:50%;border:0;background:var(--sb-brand);color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;transition:transform .15s;}",
      ".sb-launcher:hover{transform:scale(1.06);}",
      ".sb-panel{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:370px;max-width:calc(100vw - 40px);height:560px;max-height:calc(100vh - 120px);background:#fff;color:#111;border-radius:var(--sb-radius);box-shadow:0 12px 40px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .18s,transform .18s;}",
      ".sb-panel.sb-open{opacity:1;transform:none;pointer-events:auto;}",
      ".sb-header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--sb-brand);color:#fff;}",
      ".sb-logo{width:28px;height:28px;border-radius:50%;object-fit:cover;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;font-size:18px;}",
      ".sb-title{font-weight:600;font-size:15px;flex:1;}",
      ".sb-close{background:transparent;border:0;color:#fff;font-size:16px;cursor:pointer;opacity:.85;}",
      ".sb-close:hover{opacity:1;}",
      ".sb-log{flex:1;overflow-y:auto;padding:16px;background:#f7f8fb;}",
      ".sb-msg{display:flex;margin:8px 0;}",
      ".sb-user{justify-content:flex-end;}",
      ".sb-bubble{max-width:80%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word;}",
      ".sb-bot .sb-bubble{background:#fff;border:1px solid #e6e8ef;border-bottom-left-radius:4px;}",
      ".sb-user .sb-bubble{background:var(--sb-brand);color:#fff;border-bottom-right-radius:4px;}",
      ".sb-bubble a{color:var(--sb-brand);text-decoration:underline;word-break:break-word;}",
      ".sb-typing{color:#999;}",
      ".sb-sources{font-size:11px;color:#7a8194;margin:2px 4px 10px;}",
      ".sb-sources a{color:var(--sb-brand);text-decoration:none;}",
      ".sb-sources a:hover{text-decoration:underline;}",
      ".sb-notice{font-size:11px;color:#8a90a2;padding:6px 16px;background:#f7f8fb;border-top:1px solid #eef0f5;}",
      ".sb-form{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #eef0f5;background:#fff;}",
      ".sb-input{flex:1;border:1px solid #dfe2ec;border-radius:20px;padding:10px 14px;font-size:14px;outline:none;color:#111;}",
      ".sb-input:focus{border-color:var(--sb-brand);}",
      ".sb-send{width:40px;height:40px;border-radius:50%;border:0;background:var(--sb-brand);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}",
      // Consent-Popup: gleiche Position wie das Panel, über allem, blockiert bis zur Entscheidung.
      ".sb-consent{position:fixed;right:20px;bottom:88px;z-index:2147483001;width:370px;max-width:calc(100vw - 40px);background:#fff;color:#111;border-radius:var(--sb-radius);box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;transform:translateY(12px) scale(.98);pointer-events:none;transition:opacity .18s,transform .18s;}",
      ".sb-consent.sb-open{opacity:1;transform:none;pointer-events:auto;}",
      ".sb-consent-box{padding:20px;}",
      ".sb-consent-title{margin:0 0 10px;font-size:15px;font-weight:700;color:#111;}",
      ".sb-consent-text{margin:0 0 12px;font-size:13px;line-height:1.5;color:#333;}",
      ".sb-consent-privacy-wrap{margin:0 0 16px;font-size:13px;}",
      ".sb-consent-privacy{color:#1a73e8;font-weight:600;text-decoration:underline;cursor:pointer;}",
      ".sb-consent-actions{display:flex;flex-direction:column;gap:8px;}",
      ".sb-consent-actions button{width:100%;padding:11px 12px;border-radius:10px;border:0;font-size:14px;font-weight:600;cursor:pointer;line-height:1.3;}",
      ".sb-consent-accept{background:var(--sb-brand);color:#fff;}",
      ".sb-consent-reject{background:#eceef3;color:#333;}",
      "@media (max-width:480px){.sb-panel{right:0;bottom:0;width:100vw;max-width:100vw;height:100vh;max-height:100vh;border-radius:0;}.sb-launcher{right:16px;bottom:16px;}.sb-consent{right:12px;left:12px;width:auto;max-width:none;bottom:88px;}}",
    ].join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function escapeAttr(s) { return escapeHtml(s); }

  // Minimales, SICHERES Markdown-Rendering: erst HTML escapen, dann nur
  // Markdown-Links, **fett** und blanke http(s)-URLs in <a> umwandeln.
  // Nur http/https-Links werden verlinkt (kein javascript:), target=_blank + noopener.
  function renderMarkdown(text) {
    var html = escapeHtml(text);
    // **fett**
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    // Markdown-Link [Text](http-URL)  (nach escape ist "&" -> "&amp;", in href gültig)
    html = html.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      function (m, t, u) {
        return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
      }
    );
    // Blanke URLs (nicht bereits in einem Tag/Attribut) verlinken.
    html = html.replace(
      /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      function (m, pre, u) {
        return pre + '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + "</a>";
      }
    );
    return html;
  }

  // Branding laden, dann UI bauen (bei Fehler mit Defaults bauen).
  fetch(apiBase + "/api/widget/" + encodeURIComponent(botId) + "/config")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (data) {
        cfg.botName = data.botName || cfg.botName;
        cfg.primaryColor = data.primaryColor || cfg.primaryColor;
        cfg.greeting = data.greeting || cfg.greeting;
        cfg.logoUrl = data.logoUrl || "";
        cfg.aiNotice = data.aiNotice || cfg.aiNotice;
        cfg.status = data.status || "active";
        cfg.consentNotice = data.consentNotice || cfg.consentNotice;
        cfg.privacyUrl = data.privacyUrl || cfg.privacyUrl;
      }
    })
    .catch(function () {})
    .then(function () {
      if (document.body) build();
      else window.addEventListener("DOMContentLoaded", build);
      console.log("[SiteBot] Widget bereit für", botId);
    });
})();
