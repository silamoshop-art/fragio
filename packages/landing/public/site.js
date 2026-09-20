/* Fragio — gemeinsames Verhalten für alle Seiten. */
(function () {
  "use strict";

  // --- Mobile-Navigation ---
  var toggle = document.querySelector(".nav-toggle");
  var navLinks = document.querySelector(".nav-links");
  if (toggle && navLinks) {
    if (!navLinks.id) navLinks.id = "nav-menu";
    toggle.setAttribute("aria-controls", navLinks.id);
    var setNav = function (open) {
      document.body.classList.toggle("nav-open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle.addEventListener("click", function () {
      setNav(!document.body.classList.contains("nav-open"));
    });
    Array.prototype.forEach.call(navLinks.querySelectorAll("a"), function (a) {
      a.addEventListener("click", function () { setNav(false); });
    });
    // Escape schließt das offene Menü und gibt den Fokus an den Auslöser zurück.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && document.body.classList.contains("nav-open")) {
        setNav(false);
        toggle.focus();
      }
    });
  }

  // --- Aktiven Menüpunkt markieren ---
  var path = location.pathname.replace(/\/index\.html$/, "/");
  Array.prototype.forEach.call(document.querySelectorAll(".nav-links > a"), function (a) {
    if (a.classList.contains("btn")) return;
    var href = a.getAttribute("href");
    if (href && href.length > 1 && path.indexOf(href) === 0) a.classList.add("active");
  });

  // --- Hover-Lift (auch ohne weitere Skripte) ---
  Array.prototype.forEach.call(document.querySelectorAll("[data-lift]"), function (el) { el.classList.add("lift"); });

  // --- Reveal-Animation: robust, lässt nie etwas unsichtbar hängen ---
  var reduce = false;
  try { reduce = matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  if (reduce) return;

  var els = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  els.forEach(function (el) {
    el.classList.add("reveal");
    var d = el.getAttribute("data-reveal");
    if (d) el.style.transitionDelay = (parseInt(d, 10) || 0) + "ms";
  });
  function check() {
    var h = window.innerHeight || document.documentElement.clientHeight;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.classList.contains("in")) continue;
      var r = el.getBoundingClientRect();
      if (r.top < h * 0.92 && r.bottom > 0) el.classList.add("in");
    }
  }
  window.addEventListener("scroll", check, { passive: true });
  window.addEventListener("resize", check);
  check();
  // Sicherheitsnetz: nach kurzer Zeit .reveal entfernen -> garantiert sichtbar.
  setTimeout(function () { els.forEach(function (el) { el.classList.remove("reveal"); }); }, 1700);
})();

// --- Preise/Kontingente live aus der Admin-Preisliste übernehmen ---
// Preiskarten (data-plan) und der Einrichtungsgebühr-Hinweis (#price-note)
// werden aus /api/signup/plans befüllt -> eine Preisänderung im Admin wirkt
// sofort auf allen Seiten. Es wird nur die ZAHL ersetzt; das Label (inkl.
// i18n-Übersetzung, die vorher lief) bleibt unangetastet.
(function () {
  "use strict";
  var cards = document.querySelectorAll("[data-plan]");
  var note = document.getElementById("price-note");
  var minEl = document.querySelector("[data-min-price]");
  if (!cards.length && !note && !minEl) return;

  function fmt(n, en) {
    // de-DE liefert zuverlässig den Punkt als Tausendertrennzeichen (2.000),
    // passend zum übrigen Seitentext; de-AT nutzt hier ein schmales Leerzeichen.
    try { return Number(n).toLocaleString(en ? "en-US" : "de-DE"); }
    catch (e) { return String(n); }
  }
  // Ersetzt die erste Zahl im ersten ziffernhaltigen Textknoten; behält € und
  // ein evtl. <span>-Suffix ("/Monat") sowie die Sprache des Labels.
  function setNumber(el, numStr) {
    if (!el) return;
    for (var i = 0; i < el.childNodes.length; i++) {
      var node = el.childNodes[i];
      if (node.nodeType === 3 && /\d/.test(node.nodeValue)) {
        node.nodeValue = node.nodeValue.replace(/[\d.,  ]*\d/, numStr);
        return;
      }
    }
    if (!el.children.length) el.textContent = numStr;
  }

  fetch("/api/signup/plans")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.plans) return;
      var en = document.documentElement.lang === "en";
      var by = {};
      d.plans.forEach(function (p) { by[p.id] = p; });
      Array.prototype.forEach.call(cards, function (card) {
        var p = by[card.getAttribute("data-plan")];
        if (!p) return;
        setNumber(card.querySelector(".price"), fmt(p.monthlyCents / 100, en));
        setNumber(card.querySelector(".quota"), fmt(p.limit, en));
      });
      // "Ab X €"-Hero-Zeile = günstigster Tarif. Nur die Zahl im <strong>
      // ersetzen; zusätzlich die EN-Vorlage (data-i18n-en) mitziehen, damit ein
      // späterer Sprachwechsel den aktuellen Preis behält.
      if (minEl) {
        var minCents = d.plans.reduce(function (m, p) {
          return typeof p.monthlyCents === "number" && (m === null || p.monthlyCents < m) ? p.monthlyCents : m;
        }, null);
        if (minCents !== null) {
          var strong = minEl.querySelector("strong") || minEl;
          setNumber(strong, fmt(minCents / 100, en));
          var tpl = minEl.getAttribute("data-i18n-en");
          if (tpl) minEl.setAttribute("data-i18n-en", tpl.replace(/[\d.,]*\d/, fmt(minCents / 100, true)));
        }
      }
      // Einrichtungsgebühr-Hinweis nur, wenn im Admin aktiviert.
      if (note && d.setupFeeEnabled) {
        var sc = (d.plans[0] && d.plans[0].setupCents) || 0;
        if (sc > 0) {
          var eur = (sc / 100).toLocaleString(en ? "en-IE" : "de-AT", { style: "currency", currency: d.currency || "EUR" });
          note.removeAttribute("data-i18n-en"); // ab jetzt ist dieses Skript die Quelle
          note.innerHTML = '<strong style="color:var(--ink)">' +
            (en ? ("One-time setup fee: " + eur + ".") : ("Einmalige Einrichtungsgebühr: " + eur + ".")) + "</strong> " +
            (en ? "No VAT charged (small-business scheme), cancellable monthly. Payment by invoice — bank transfer with QR code."
                : "Keine Umsatzsteuer (Kleinunternehmer), monatlich kündbar. Bezahlung per Rechnung — Überweisung mit QR-Code.");
        }
      }
    })
    .catch(function () {});
})();

// --- Fragios eigenes Chat-Widget site-weit laden ---
// Wir sind selbst ein Fragio-Kunde: existiert für diese Domain ein Betreiber-Bot,
// erscheint das Widget (Sprechblase unten rechts) automatisch. Nicht auf der
// Testseite (die hat ihre eigene Demo).
(function () {
  "use strict";
  if (/testen(\.html)?$/.test(location.pathname)) return;
  fetch("/api/widget/site")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      if (!d || !d.botId) return;
      if (document.querySelector('script[data-sitebot], script[data-bot-id]')) return;
      var s = document.createElement("script");
      s.src = "/widget/widget.js";
      s.setAttribute("data-bot-id", d.botId);
      s.async = true;
      document.body.appendChild(s);
    })
    .catch(function () {});
})();
