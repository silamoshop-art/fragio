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
    greeting: "Hallo! Frag mich etwas über diese Website.",
    logoUrl: "",
    aiNotice: "Dies ist ein KI-Chatbot. Antworten können Fehler enthalten.",
    status: "active",
    lang: "de-DE",
    leadCapture: false,
    leadIntro:
      "Ich konnte deine Frage nicht aus der Website beantworten. Sollen wir uns bei dir melden? Hinterlasse einfach deine Kontaktdaten.",
    bookingUrl: "",
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
    var micBtn = root.querySelector(".sb-mic");
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

    // ---- Spracheingabe (Web Speech API) ----
    // Läuft ausschließlich im Browser des Besuchers und startet NUR nach explizitem
    // Klick samt Browser-Mikrofon-Erlaubnis. Wird die API nicht unterstützt, bleibt
    // der Button verborgen (Graceful Degradation) — der Chat funktioniert normal.
    (function setupVoice() {
      var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR || !micBtn) { if (micBtn) micBtn.hidden = true; return; }
      micBtn.hidden = false;
      var rec = null, listening = false, base = "";
      micBtn.addEventListener("click", function () {
        if (listening) { try { rec && rec.stop(); } catch (e) {} return; }
        try {
          rec = new SR();
          rec.lang = cfg.lang || "de-DE";
          rec.interimResults = true;
          rec.maxAlternatives = 1;
          rec.continuous = false;
          base = input.value ? input.value.trim() + " " : "";
          rec.onstart = function () {
            listening = true;
            micBtn.classList.add("sb-listening");
            micBtn.setAttribute("aria-label", "Aufnahme stoppen");
            input.setAttribute("placeholder", "Sprich jetzt …");
          };
          rec.onresult = function (e) {
            var finalText = "", interim = "";
            for (var i = 0; i < e.results.length; i++) {
              var tr = e.results[i][0].transcript;
              if (e.results[i].isFinal) finalText += tr; else interim += tr;
            }
            input.value = (base + finalText + interim).replace(/\s+/g, " ").replace(/^\s+/, "");
          };
          rec.onerror = function () { /* no-speech / not-allowed etc. — still bricht onend ab */ };
          rec.onend = function () {
            listening = false;
            micBtn.classList.remove("sb-listening");
            micBtn.setAttribute("aria-label", "Frage per Sprache eingeben");
            input.setAttribute("placeholder", "Nachricht schreiben…");
            input.focus();
          };
          rec.start();
        } catch (e) {
          listening = false;
          micBtn.classList.remove("sb-listening");
        }
      });
    })();

    // Begrüßung anzeigen.
    addMsg("bot", cfg.greeting);

    // Eine Frage senden (aus dem Eingabefeld ODER per Vorschlag-Chip).
    function sendQuestion(q) {
      q = (q || "").trim();
      if (!q) return;
      removeSuggestions(); // Starter-Vorschläge ausblenden, sobald das Gespräch läuft
      addMsg("user", q);
      var bubble = addMsg("bot", "");
      bubble.classList.add("sb-typing");
      bubble.textContent = "…";
      var first = true, sources = null, acc = "", msgId = null, answered = true, escalated = false;
      streamChat(q, {
        meta: function (m) {
          sources = m.sources;
          if (m.msgId) msgId = m.msgId;
          if (typeof m.answered === "boolean") answered = m.answered;
          if (m.escalated) escalated = true;
        },
        token: function (t) {
          if (first) { bubble.classList.remove("sb-typing"); acc = ""; first = false; }
          acc += t;
          // Markdown (Links + **fett**) klickbar rendern statt als Rohtext.
          bubble.innerHTML = renderMarkdown(acc);
          log.scrollTop = log.scrollHeight;
        },
        error: function (msg) { bubble.classList.remove("sb-typing"); bubble.textContent = msg; },
        done: function () {
          if (first) { bubble.classList.remove("sb-typing"); bubble.textContent = "(keine Antwort)"; }
          addSources(sources);
          // Bewertung (Daumen hoch/runter) unter jede echte Antwort.
          if (acc && msgId) addFeedback(msgId);
          // Abgeschlossenen Austausch dem Verlauf hinzufügen (für Folgefragen).
          if (acc) {
            history.push({ role: "user", content: q });
            history.push({ role: "assistant", content: acc });
            if (history.length > HISTORY_MAX) history = history.slice(-HISTORY_MAX);
          }
          // Konnte der Bot nicht helfen ODER wurde eskaliert: Kontaktformular /
          // Terminlink anbieten (Anforderung A+D). Nur, wenn für diesen Bot aktiviert.
          if (!answered || escalated) offerLead(q);
        },
      });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      input.value = "";
      sendQuestion(q);
    });

    // ---- Vorauswahl: die drei häufigsten Fragen als Chips ----
    var suggestionsRow = null;
    function removeSuggestions() {
      if (suggestionsRow && suggestionsRow.parentNode) suggestionsRow.parentNode.removeChild(suggestionsRow);
      suggestionsRow = null;
    }
    function renderSuggestions(questions) {
      removeSuggestions();
      if (!questions || !questions.length) return;
      var row = document.createElement("div");
      row.className = "sb-chips";
      questions.slice(0, 3).forEach(function (q) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "sb-chip";
        chip.textContent = q;
        chip.addEventListener("click", function () { sendQuestion(q); });
        row.appendChild(chip);
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
      suggestionsRow = row;
    }
    // Vorschläge laden (Fehler ignorieren — der Chat funktioniert auch ohne).
    fetch(apiBase + "/api/widget/" + encodeURIComponent(botId) + "/top-questions")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && d.questions) renderSuggestions(d.questions); })
      .catch(function () {});

    // ---- Bewertung: Daumen hoch/runter ----
    function addFeedback(msgId) {
      var row = document.createElement("div");
      row.className = "sb-feedback";
      var label = document.createElement("span");
      label.className = "sb-feedback-label";
      label.textContent = "War das hilfreich?";
      row.appendChild(label);
      var done = false;
      function vote(rating, btn) {
        if (done) return;
        done = true;
        row.classList.add("sb-voted");
        btn.classList.add("sb-fb-active");
        label.textContent = "Danke für dein Feedback!";
        try {
          fetch(apiBase + "/api/chat/" + encodeURIComponent(botId) + "/feedback", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ msgId: msgId, rating: rating }),
            keepalive: true,
          }).catch(function () {});
        } catch (e) {}
      }
      var THUMB_UP =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
      var THUMB_DOWN =
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/></svg>';
      [["up", THUMB_UP, "Hilfreich"], ["down", THUMB_DOWN, "Nicht hilfreich"]].forEach(function (v) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "sb-fb sb-fb-" + v[0];
        b.setAttribute("aria-label", v[2]);
        b.title = v[2];
        b.innerHTML = v[1];
        b.addEventListener("click", function () { vote(v[0], b); });
        row.appendChild(b);
      });
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    // ---- Lead-Erfassung / Terminlink (Anforderung A+D) ----
    // Wird angeboten, wenn der Bot eine Frage nicht beantworten konnte. Pro Sitzung
    // nur einmal aktiv anzeigen, um nicht aufdringlich zu wirken.
    var leadOffered = false;
    function offerLead(contextQ) {
      if (!cfg.leadCapture && !cfg.bookingUrl) return;
      if (leadOffered) return;
      leadOffered = true;

      var card = document.createElement("div");
      card.className = "sb-lead";
      var intro = document.createElement("p");
      intro.className = "sb-lead-intro";
      intro.textContent = cfg.leadIntro;
      card.appendChild(intro);

      // Terminlink (falls hinterlegt) als deutlicher Button.
      if (cfg.bookingUrl) {
        var a = document.createElement("a");
        a.className = "sb-book";
        a.href = cfg.bookingUrl;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "Termin vereinbaren";
        card.appendChild(a);
      }

      if (cfg.leadCapture) {
        var f = document.createElement("form");
        f.className = "sb-lead-form";
        f.innerHTML =
          '<input class="sb-lead-name" type="text" placeholder="Name (optional)" autocomplete="name" maxlength="120" />' +
          '<input class="sb-lead-email" type="email" placeholder="E-Mail" autocomplete="email" maxlength="200" />' +
          '<input class="sb-lead-phone" type="tel" placeholder="Telefon (optional)" autocomplete="tel" maxlength="60" />' +
          '<textarea class="sb-lead-msg" rows="2" placeholder="Dein Anliegen (optional)" maxlength="2000"></textarea>' +
          '<button class="sb-lead-submit" type="submit">Absenden</button>' +
          '<p class="sb-lead-hint" aria-live="polite"></p>';
        var hint = f.querySelector(".sb-lead-hint");
        f.addEventListener("submit", function (e) {
          e.preventDefault();
          var email = f.querySelector(".sb-lead-email").value.trim();
          var phone = f.querySelector(".sb-lead-phone").value.trim();
          if (!email && !phone) {
            hint.textContent = "Bitte E-Mail oder Telefon angeben.";
            hint.className = "sb-lead-hint sb-lead-err";
            return;
          }
          var btn = f.querySelector(".sb-lead-submit");
          btn.disabled = true;
          btn.textContent = "Wird gesendet…";
          fetch(apiBase + "/api/chat/" + encodeURIComponent(botId) + "/lead", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: f.querySelector(".sb-lead-name").value.trim(),
              email: email,
              phone: phone,
              message: f.querySelector(".sb-lead-msg").value.trim(),
              contextQuestion: contextQ || "",
            }),
          })
            .then(function (r) {
              if (!r.ok) throw new Error("HTTP " + r.status);
              card.innerHTML =
                '<p class="sb-lead-done">Danke! Wir haben deine Anfrage erhalten und melden uns bei dir.</p>';
            })
            .catch(function () {
              btn.disabled = false;
              btn.textContent = "Absenden";
              hint.textContent = "Senden fehlgeschlagen. Bitte später erneut versuchen.";
              hint.className = "sb-lead-hint sb-lead-err";
            });
        });
        card.appendChild(f);
      }

      log.appendChild(card);
      log.scrollTop = log.scrollHeight;
    }
  }

  function template(c) {
    var logo = c.logoUrl
      ? '<img class="sb-logo" src="' + escapeAttr(c.logoUrl) + '" alt="" />'
      : '<span class="sb-logo sb-logo-fallback"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></span>';
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
      '    <button class="sb-mic" type="button" aria-label="Frage per Sprache eingeben" title="Frage per Sprache eingeben" hidden>' +
      '      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>' +
      "    </button>" +
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
      ".sb-chips{display:flex;flex-wrap:wrap;gap:6px;margin:4px 4px 10px;}",
      ".sb-chip{background:#fff;border:1px solid #dfe2ec;color:var(--sb-brand);border-radius:14px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;line-height:1.2;text-align:left;font-family:inherit;}",
      ".sb-chip:hover{border-color:var(--sb-brand);background:#f4f5fb;}",
      ".sb-feedback{display:flex;align-items:center;gap:6px;margin:0 4px 10px;}",
      ".sb-feedback-label{font-size:11px;color:#8a90a2;}",
      ".sb-fb{background:transparent;border:1px solid #e6e8ef;border-radius:12px;padding:2px 8px;font-size:13px;line-height:1.4;cursor:pointer;opacity:.75;}",
      ".sb-fb:hover{opacity:1;border-color:var(--sb-brand);}",
      ".sb-fb-active{opacity:1;border-color:var(--sb-brand);background:#f4f5fb;}",
      ".sb-voted .sb-fb{cursor:default;}",
      ".sb-lead{background:#fff;border:1px solid #e6e8ef;border-radius:14px;padding:14px;margin:2px 4px 12px;}",
      ".sb-lead-intro{margin:0 0 10px;font-size:13.5px;line-height:1.45;color:#333;}",
      ".sb-book{display:block;text-align:center;background:var(--sb-brand);color:#fff;text-decoration:none;border-radius:10px;padding:10px 12px;font-size:13.5px;font-weight:600;margin:0 0 10px;}",
      ".sb-book:hover{opacity:.92;}",
      ".sb-lead-form{display:flex;flex-direction:column;gap:7px;}",
      ".sb-lead-form input,.sb-lead-form textarea{border:1px solid #dfe2ec;border-radius:9px;padding:9px 11px;font-size:13.5px;font-family:inherit;color:#111;outline:none;width:100%;box-sizing:border-box;}",
      ".sb-lead-form input:focus,.sb-lead-form textarea:focus{border-color:var(--sb-brand);}",
      ".sb-lead-form textarea{resize:vertical;}",
      ".sb-lead-submit{background:var(--sb-brand);color:#fff;border:0;border-radius:10px;padding:10px 12px;font-size:14px;font-weight:600;cursor:pointer;}",
      ".sb-lead-submit:disabled{opacity:.6;cursor:default;}",
      ".sb-lead-hint{margin:2px 0 0;font-size:12px;color:#8a90a2;min-height:1px;}",
      ".sb-lead-err{color:#c0392b;}",
      ".sb-lead-done{margin:0;font-size:13.5px;line-height:1.45;color:#166534;}",
      ".sb-fb svg{display:block;}",
      ".sb-notice{font-size:11px;color:#8a90a2;padding:6px 16px;background:#f7f8fb;border-top:1px solid #eef0f5;}",
      ".sb-form{display:flex;align-items:center;gap:8px;padding:10px 12px;border-top:1px solid #eef0f5;background:#fff;}",
      ".sb-input{flex:1;border:1px solid #dfe2ec;border-radius:20px;padding:10px 14px;font-size:14px;outline:none;color:#111;}",
      ".sb-input:focus{border-color:var(--sb-brand);}",
      ".sb-send{width:40px;height:40px;border-radius:50%;border:0;background:var(--sb-brand);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;}",
      ".sb-mic{width:40px;height:40px;border-radius:50%;border:0;background:#eceef3;color:#555;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:background .15s;}",
      ".sb-mic:hover{background:#e2e5ee;}",
      ".sb-mic[hidden]{display:none;}",
      ".sb-mic.sb-listening{background:var(--sb-brand);color:#fff;animation:sb-pulse 1.3s infinite;}",
      "@keyframes sb-pulse{0%,100%{box-shadow:0 0 0 0 rgba(0,0,0,0);}50%{box-shadow:0 0 0 6px rgba(0,0,0,.10);}}",
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
    // Überschriften (# … bis ###### …) am Zeilenanfang -> saubere Fett-Zeile,
    // damit nie ein rohes "# Titel" im Chat steht (professionelles Aussehen).
    html = html.replace(/^\s{0,3}#{1,6}\s*(.+?)\s*$/gm, "<strong>$1</strong>");
    // Einfache Aufzählungspunkte "- "/"* " am Zeilenanfang -> "• " (sauberer Punkt).
    html = html.replace(/^\s*[-*]\s+/gm, "• ");
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
        cfg.lang = data.lang || cfg.lang;
        cfg.consentNotice = data.consentNotice || cfg.consentNotice;
        cfg.privacyUrl = data.privacyUrl || cfg.privacyUrl;
        cfg.leadCapture = !!data.leadCapture;
        if (data.leadIntro) cfg.leadIntro = data.leadIntro;
        cfg.bookingUrl = data.bookingUrl || "";
      }
    })
    .catch(function () {})
    .then(function () {
      if (document.body) build();
      else window.addEventListener("DOMContentLoaded", build);
      console.log("[SiteBot] Widget bereit für", botId);
    });
})();
