/* Fragio — gemeinsames Verhalten für alle Seiten. */
(function () {
  "use strict";

  // --- Mobile-Navigation ---
  var toggle = document.querySelector(".nav-toggle");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".nav-links a"), function (a) {
      a.addEventListener("click", function () {
        document.body.classList.remove("nav-open");
        toggle.setAttribute("aria-expanded", "false");
      });
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
