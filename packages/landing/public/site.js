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
