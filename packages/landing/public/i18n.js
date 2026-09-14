/* Fragio — In-Page-Sprachumschaltung DE/EN.
 * Deutsch ist die Ausgangssprache im HTML. Für Englisch werden reine Text-Elemente
 * (ohne verschachtelte Element-Kinder) über ihren deutschen textContent nachgeschlagen
 * und ersetzt. Nicht im Wörterbuch enthaltene Texte bleiben unverändert (fällt sicher
 * auf Deutsch zurück). Die Wahl wird in localStorage gemerkt. */
(function () {
  "use strict";
  var KEY = "fragio_lang";

  // Deutscher textContent  ->  Englisch.
  var EN = {
    // Navigation
    "Funktionen": "Features",
    "So funktioniert's": "How it works",
    "Preise": "Pricing",
    "FAQ": "FAQ",
    "Kontakt": "Contact",
    "Login": "Login",
    "Jetzt bestellen": "Order now",
    "Zum Inhalt springen": "Skip to content",
    // Hero (Start)
    "KI-Chat für Websites": "AI chat for websites",
    "Der Chatbot, der nur sagt, was auf Ihrer Website steht.": "The chatbot that only says what's on your website.",
    "Fragio liest Ihre Website und beantwortet Besucherfragen daraus — kurz, konkret, mit Quellenangabe. Steht etwas nicht auf der Seite, sagt der Bot das offen, statt es zu erfinden.": "Fragio reads your website and answers visitor questions from it — short, precise, with a source link. If something isn't on the page, the bot says so openly instead of making it up.",
    "Dazu steht auf der Website leider kein Preis. Am besten kurz anrufen unter 0732 123456 — dort bekommen Sie eine verbindliche Auskunft.": "There's unfortunately no price for that on the website. Best to call briefly on 0732 123456 — you'll get a binding answer there.",
    "Erst kostenlos testen": "Try it free first",
    "Chat mit der Website": "Chat with the website",
    "KI-Assistent": "AI assistant",
    "Habt ihr am Samstag offen?": "Are you open on Saturday?",
    "Was kostet eine Erstberatung?": "What does an initial consultation cost?",
    "Genau das ist der Unterschied: keine erfundene Zahl, sondern ein ehrliches „weiß ich nicht\".": "That's exactly the difference: no invented number, but an honest \"I don't know.\"",
    // Value band
    "Keine erfundenen Antworten. Der Bot arbeitet ausschließlich mit den Inhalten Ihrer eigenen Website — und nennt die Seite, aus der die Antwort kommt.": "No invented answers. The bot works exclusively with the content of your own website — and names the page the answer comes from.",
    // Sections (Start)
    "Was Fragio für Sie übernimmt": "What Fragio does for you",
    "Rund um die Uhr Fragen beantworten — professionell und ohne Erfindungen.": "Answering questions around the clock — professional and without inventions.",
    "Alle Funktionen →": "All features →",
    "Antwortet rund um die Uhr": "Answers around the clock",
    "Die Fragen, die sonst am Telefon landen, sind auch um 21:30 beantwortet.": "The questions that usually end up on the phone are answered at 9:30 p.m. too.",
    "Bleibt automatisch aktuell": "Stays up to date automatically",
    "Einmal pro Woche wird Ihre Website neu gelesen — neue Preise oder Inhalte kennt der Bot ab dem nächsten Lauf.": "Your website is re-read once a week — the bot knows new prices or content from the next run.",
    "Zeigt Ihre Content-Lücken": "Shows your content gaps",
    "Jede Frage, die der Bot nicht beantworten konnte, sehen Sie in Ihrem Dashboard — Ihre To-do-Liste.": "Every question the bot couldn't answer shows up in your dashboard — your to-do list.",
    "In drei Schritten startklar": "Ready in three steps",
    "In drei Schritten startklar.": "Ready in three steps.",
    "Kein technisches Vorwissen nötig.": "No technical knowledge required.",
    "So funktioniert's im Detail →": "How it works in detail →",
    "Website eintragen": "Enter your website",
    "Vorab testen": "Test in advance",
    "Eine Zeile einfügen": "Add one line",
    "Einfache, faire Preise": "Simple, fair pricing",
    "Monatlich, ohne Bindung. Online bestellen, Rechnung per E-Mail.": "Monthly, no commitment. Order online, invoice by email.",
    "Alle Details & bestellen →": "All details & order →",
    "Bestellen": "Order",
    "Empfohlen": "Recommended",
    "Bereit, Ihre Besucher besser zu beantworten?": "Ready to answer your visitors better?",
    "Testen Sie den Bot kostenlos mit Ihrer eigenen Website — oder bestellen Sie direkt online.": "Test the bot for free with your own website — or order directly online.",
    "Kostenlos testen": "Try for free",
    // Footer
    "KI-Chat für Website-Inhalte. Ehrliche Antworten aus Ihren eigenen Seiten. Standort Linz, Oberösterreich.": "AI chat for website content. Honest answers from your own pages. Based in Linz, Austria.",
    "Produkt": "Product",
    "Live testen": "Live demo",
    "Unternehmen": "Company",
    "Über Fragio": "About Fragio",
    "Kunden-Login": "Customer login",
    "Rechtliches": "Legal",
    "Impressum": "Imprint",
    "Datenschutz": "Privacy",
    "AGB": "Terms",
    "Dies ist ein KI-Assistent.": "This is an AI assistant.",
    // Funktionen page
    "Ein Assistent, der ehrlich bleibt.": "An assistant that stays honest.",
    "Fragio beantwortet Besucherfragen ausschließlich aus Ihren eigenen Website-Inhalten — und macht dabei vieles, was gute Beratung ausmacht.": "Fragio answers visitor questions exclusively from your own website content — and does much of what good advice is made of.",
    "Nennt die Quelle": "Names the source",
    "Jede Antwort verweist auf die Seite, aus der sie stammt — als klickbarer Link. Nachvollziehbar statt Blackbox.": "Every answer links to the page it comes from — as a clickable link. Transparent instead of a black box.",
    "Erfindet nichts": "Invents nothing",
    "Steht etwas nicht auf Ihrer Website, sagt der Bot das offen — statt Preise, Adressen oder Termine zu erfinden.": "If something isn't on your website, the bot says so openly — instead of inventing prices, addresses or appointments.",
    "Spricht wie Ihr Betrieb": "Speaks like your business",
    "Hinterlegen Sie einen kurzen Beispieltext — der Bot übernimmt den Tonfall (per Du oder förmlich), Fachbegriffe bleiben exakt.": "Provide a short sample text — the bot adopts the tone (casual or formal), technical terms stay exact.",
    "Jede unbeantwortete Frage sehen Sie im Dashboard. „14× nach Parkplätzen gefragt, 0× erwähnt\" — das ist Ihre To-do-Liste.": "You see every unanswered question in the dashboard. \"Asked 14× about parking, mentioned 0×\" — that's your to-do list.",
    "Spracheingabe": "Voice input",
    "Besucher können ihre Frage einfach einsprechen statt tippen — bequem am Handy, ganz ohne App.": "Visitors can simply speak their question instead of typing — convenient on mobile, without any app.",
    "Bewertung & Korrektur": "Rating & correction",
    "Besucher bewerten jede Antwort mit Daumen hoch/runter. Sie können Antworten nachträglich überschreiben — recrawl-fest.": "Visitors rate every answer thumbs up/down. You can override answers afterwards — and they survive re-crawling.",
    "PDF-Dokumente inklusive": "PDF documents included",
    "Fragio liest auch verlinkte PDFs (z. B. Preislisten oder Info-Blätter) mit ein — nicht nur normale Seiten.": "Fragio also reads linked PDFs (e.g. price lists or info sheets) — not just regular pages.",
    "Am besten selbst erleben.": "Best experienced yourself.",
    "Geben Sie Ihre Website-Adresse ein und stellen Sie dem Bot ein paar Fragen — kostenlos, ohne Konto.": "Enter your website address and ask the bot a few questions — free, no account.",
    "Zu den Preisen": "See pricing",
    // Ablauf page
    "Kein technisches Vorwissen nötig — auf Wunsch übernehmen wir die Einrichtung komplett für Sie.": "No technical knowledge required — on request we handle the entire setup for you.",
    "Vorab testen": "Test in advance",
    "Lieber alles fertig?": "Prefer it all done for you?",
    "Bestellen Sie einen Tarif und wir richten Ihren Chatbot vollständig ein — Website einlesen, Feinschliff, Einbau. Sie bekommen die fertige Lösung plus Zugang zum Dashboard.": "Order a plan and we set up your chatbot completely — reading your website, fine-tuning, integration. You get the finished solution plus dashboard access.",
    "Tarif wählen & bestellen": "Choose a plan & order",
    "Jetzt ausprobieren": "Try it now",
    "Kostenlos mit Ihrer eigenen Website — in unter einer Minute.": "Free with your own website — in under a minute.",
    // Testen page
    "Live testen": "Live demo",
    "Probieren Sie es mit Ihrer Website.": "Try it with your website.",
    "Adresse eintragen, kurz warten, Fragen stellen. Fragio liest ein paar Seiten live ein und antwortet mit Ihren echten Inhalten. Kein Konto, keine Zahlungsdaten — die Demo-Daten werden automatisch wieder gelöscht.": "Enter your address, wait briefly, ask questions. Fragio reads a few pages live and answers with your real content. No account, no payment details — the demo data is deleted automatically.",
    "Website einlesen": "Read website",
    "Noch keine Website eingelesen. Tragen Sie oben Ihre Adresse ein — es wird nichts an Ihrer Website verändert.": "No website read yet. Enter your address above — nothing on your website is changed.",
    "Dies ist ein KI-Assistent. Antworten stammen ausschließlich aus den gelesenen Website-Inhalten.": "This is an AI assistant. Answers come exclusively from the website content that was read.",
    "Frage stellen": "Ask a question",
    "Jetzt für meine Website bestellen": "Order now for my website",
    "Andere Website": "Different website",
    "Erneut versuchen": "Try again",
    "Überzeugt?": "Convinced?",
    "Bestellen Sie Ihren Bot online — Rechnung per E-Mail, danach automatisch startklar.": "Order your bot online — invoice by email, then ready automatically.",
    // Preise page
    "Monatlich, ohne Bindung. Direkt online bestellen — Sie bekommen die Rechnung per E-Mail und der Chatbot ist nach Zahlungseingang startklar. „Anfragen\" = beantwortete Besucherfragen pro Monat.": "Monthly, no commitment. Order directly online — you get the invoice by email and the chatbot is ready once payment arrives. \"Requests\" = answered visitor questions per month.",
    "Häufige Fragen zur Bestellung": "Frequently asked questions about ordering",
    "Alles Wichtige zu Zahlung, Laufzeit und Ablauf.": "Everything important about payment, term and process.",
    "Wie bezahle ich?": "How do I pay?",
    "Was passiert nach der Zahlung?": "What happens after payment?",
    "Kann ich jederzeit kündigen?": "Can I cancel anytime?",
    "Kann ich den Tarif wechseln?": "Can I change my plan?",
    "Noch unsicher?": "Still unsure?",
    "Testen Sie den Bot zuerst kostenlos mit Ihrer eigenen Website — ganz ohne Konto.": "Test the bot for free with your own website first — without any account.",
    "Frage stellen": "Ask a question",
    // FAQ page
    "Häufige Fragen": "Frequently asked questions",
    "Woher nimmt der Bot seine Antworten?": "Where does the bot get its answers?",
    "Wie schnell ist der Bot einsatzbereit?": "How quickly is the bot ready?",
    "Wie baue ich den Bot auf meiner Website ein?": "How do I add the bot to my website?",
    "Ist das DSGVO-konform?": "Is this GDPR-compliant?",
    "Kann ich Antworten korrigieren?": "Can I correct answers?",
    "Bleibt der Bot aktuell, wenn ich meine Website ändere?": "Does the bot stay up to date when I change my website?",
    "Wie bezahle ich und kann ich kündigen?": "How do I pay and can I cancel?",
    "Was passiert mit den Demo-Daten?": "What happens to the demo data?",
    "Noch Fragen offen?": "Still have questions?",
    "Schreiben Sie uns — wir antworten meist innerhalb eines Werktags.": "Write to us — we usually reply within one business day.",
    // Über page
    "Ehrliche Antworten statt schöner Erfindungen.": "Honest answers instead of pretty inventions.",
    "Warum das wichtig ist": "Why it matters",
    "Für wen Fragio gemacht ist": "Who Fragio is made for",
    "Nah, persönlich, aus Österreich": "Close, personal, from Austria",
    "Sehen Sie selbst": "See for yourself",
    "Am überzeugendsten ist Fragio mit Ihrer eigenen Website. Ein kurzer Test genügt.": "Fragio is most convincing with your own website. A quick test is enough.",
    "Preise ansehen": "View pricing",
    // Kontakt page
    "Schreiben Sie uns.": "Write to us.",
    "Ob Frage zur Einrichtung, zu einem Tarif oder zur Integration — wir helfen gern. Antwort meist innerhalb eines Werktags.": "Whether a question about setup, a plan or integration — we're happy to help. Reply usually within one business day.",
    "E-Mail": "Email",
    "E-Mail schreiben": "Write an email",
    "Standort": "Location",
    "Linz, Oberösterreich": "Linz, Austria",
    "Betreut Kundinnen und Kunden in ganz Österreich und darüber hinaus — die Einrichtung läuft komplett online.": "Serving customers across Austria and beyond — setup runs entirely online.",
    // Preise: Kontingente & Leistungen
    "/Monat": " /mo",
    "500 Anfragen im Monat": "500 requests per month",
    "2.000 Anfragen im Monat": "2,000 requests per month",
    "5.000 Anfragen im Monat": "5,000 requests per month",
    "Website-Crawl inkl. PDFs": "Website crawl incl. PDFs",
    "Wöchentliches Auto-Update": "Weekly auto-update",
    "Analytics: häufigste & offene Fragen": "Analytics: top & unanswered questions",
    "Support per E-Mail": "Support by email",
    "Alles aus Starter": "Everything in Starter",
    "Manuelle FAQ-Antworten hinterlegbar": "Custom FAQ answers",
    "Eigener Schreibstil per Beispieltext": "Own writing style via sample text",
    "Antworten nachträglich korrigierbar": "Answers editable afterwards",
    "Alles aus Business": "Everything in Business",
    "Mehrere Sprachen auf einer Website": "Multiple languages on one site",
    "Branding: eigenes Logo & Bot-Name": "Branding: own logo & bot name",
    "Einrichtung & Feinschliff übernehmen wir": "We handle setup & fine-tuning",
    // Preise: Billing-FAQ-Antworten
    "Nach der Bestellung bekommen Sie sofort eine Rechnung per E-Mail — mit IBAN, Verwendungszweck und QR-Code für Ihre Banking-App. Sie zahlen per Überweisung oder PayPal.": "After ordering you immediately get an invoice by email — with IBAN, payment reference and a QR code for your banking app. You pay by bank transfer or PayPal.",
    "Sobald Ihre Zahlung eingegangen ist, richten wir Ihren Chatbot automatisch ein, lesen Ihre Website ein und schicken Ihnen die Zugangsdaten fürs Dashboard.": "As soon as your payment arrives, we set up your chatbot automatically, read your website and send you the dashboard login details.",
    "Ja. Alle Tarife sind monatlich und ohne Bindung — Sie können jederzeit zum Monatsende kündigen.": "Yes. All plans are monthly and without commitment — you can cancel anytime at the end of the month.",
    "Ja, jederzeit hoch- oder runterstufen. Schreiben Sie uns einfach — die Änderung gilt ab dem nächsten Abrechnungszeitraum.": "Yes, upgrade or downgrade anytime. Just write to us — the change applies from the next billing period.",
    // FAQ-Seite: Antworten
    "Ausschließlich aus den Inhalten Ihrer eigenen Website, inklusive verlinkter PDF-Dokumente. Der Bot erfindet nichts — steht eine Information nicht auf der Seite, sagt er das offen und nennt die Quelle, aus der eine Antwort stammt.": "Exclusively from the content of your own website, including linked PDF documents. The bot invents nothing — if information isn't on the page, it says so openly and names the source an answer comes from.",
    "Die Vorschau ist in unter einer Minute da. Den fertig eingerichteten Bot für den Live-Einsatz bekommen Sie in der Regel innerhalb eines Werktags.": "The preview is ready in under a minute. You usually get the fully set-up bot for live use within one business day.",
    "Sie kopieren eine einzige Script-Zeile in Ihre Website. Auf Wunsch übernehmen wir den Einbau für Sie. Es sind keine technischen Kenntnisse nötig.": "You copy a single line of script into your website. On request we handle the integration for you. No technical knowledge is required.",
    "Ja. Sie können einzelne Antworten überschreiben und eigene FAQ-Antworten hinterlegen. Diese Korrekturen bleiben auch nach dem wöchentlichen Neu-Einlesen Ihrer Website erhalten.": "Yes. You can override individual answers and add your own FAQ answers. These corrections are kept even after the weekly re-reading of your website.",
    "Ja. Ihre Website wird automatisch einmal pro Woche neu eingelesen; alte Inhalte fallen dabei raus. Neue Preise oder Seiten kennt der Bot ab dem nächsten Lauf — ohne Ihr Zutun.": "Yes. Your website is re-read automatically once a week; outdated content drops out. The bot knows new prices or pages from the next run — without any effort on your part.",
    "Nach der Bestellung bekommen Sie eine Rechnung per E-Mail (Überweisung oder PayPal, inkl. QR-Code). Alle Tarife sind monatlich und ohne Bindung — jederzeit zum Monatsende kündbar.": "After ordering you get an invoice by email (bank transfer or PayPal, incl. QR code). All plans are monthly and without commitment — cancellable anytime at the end of the month.",
    "Wenn Sie die kostenlose Testfunktion nutzen, lesen wir einige öffentliche Seiten Ihrer Adresse ein. Diese Demo-Daten werden automatisch, spätestens nach 24 Stunden, wieder vollständig gelöscht.": "When you use the free test function, we read a few public pages of your address. This demo data is automatically and completely deleted, at the latest after 24 hours.",
    // Über-Seite: Absätze
    "Ein erfundener Preis oder eine falsche Öffnungszeit kostet Vertrauen — und im schlimmsten Fall einen Kunden. Fragio nennt zu jeder Antwort die Quelle, damit sie nachvollziehbar bleibt. Das schafft genau das Vertrauen, das ein guter Betrieb braucht.": "An invented price or a wrong opening time costs trust — and, in the worst case, a customer. Fragio names the source for every answer so it stays verifiable. That builds exactly the trust a good business needs.",
    "Für kleine und mittlere Betriebe, die keine Zeit haben, ständig dieselben Fragen zu beantworten: Fahrschulen, Praxen, Handwerk, Kanzleien, Vereine, Shops. Sie brauchen keine IT-Abteilung — eine Zeile Code genügt, den Rest übernehmen wir auf Wunsch.": "For small and medium businesses that don't have time to keep answering the same questions: driving schools, practices, trades, law firms, clubs, shops. You don't need an IT department — one line of code is enough, we handle the rest on request.",
    "Fragio wird in Linz entwickelt und betreut. Kein anonymer Support in einer fernen Zeitzone — sondern ein direkter Ansprechpartner, der Ihre Website kennt und beim Feinschliff hilft.": "Fragio is built and supported in Linz. No anonymous support in a distant time zone — but a direct contact who knows your website and helps with the fine-tuning.",
    // Start/Ablauf: Schritt-Texte
    "Sie nennen uns Ihre Adresse — Fragio liest alle Unterseiten, auch verlinkte PDF-Dokumente.": "You give us your address — Fragio reads all subpages, including linked PDF documents.",
    "Stellen Sie dem Bot Ihre typischen Kundenfragen — bevor irgendetwas eingebaut wird.": "Ask the bot your typical customer questions — before anything is installed.",
    "Eine Script-Zeile in Ihre Website — auf Wunsch übernehmen wir das für Sie.": "One line of script into your website — on request we do it for you.",
    "Sie stellen dem Bot Ihre typischen Kundenfragen — direkt auf einer Vorschau, bevor irgendetwas auf Ihrer Seite eingebaut wird. So sehen Sie sofort, wie gut er antwortet.": "You ask the bot your typical customer questions — right in a preview, before anything is added to your site. So you immediately see how well it answers.",
    "Passt es, kopieren Sie eine einzige Zeile in Ihre Website — fertig. Auf Wunsch übernehmen wir den Einbau.": "If it fits, copy a single line into your website — done. On request we handle the integration.",
    // Common
    "Fragen": "Ask",
    "Liest …": "Reading …",
    "Neu einlesen": "Read again",
    "Seiten werden gelesen …": "Reading pages …"
  };

  // Titel je Seite (optional).
  var TITLES = {
    "Fragio — KI-Chat für Website-Inhalte": "Fragio — AI chat for website content",
    "Funktionen — Fragio": "Features — Fragio",
    "So funktioniert's — Fragio": "How it works — Fragio",
    "Live testen — Fragio": "Live demo — Fragio",
    "Preise — Fragio": "Pricing — Fragio",
    "FAQ — Fragio": "FAQ — Fragio",
    "Über Fragio": "About Fragio",
    "Kontakt — Fragio": "Contact — Fragio"
  };

  function isPureText(el) {
    if (!el.firstChild) return false;
    for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) return false;
    return true;
  }

  function collect() {
    var out = [];
    var scopes = document.querySelectorAll("header, main, footer");
    for (var s = 0; s < scopes.length; s++) {
      var all = scopes[s].getElementsByTagName("*");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.classList && el.classList.contains("lang-toggle")) continue;
        if (isPureText(el)) out.push(el);
      }
    }
    return out;
  }

  var nodes = null;
  function apply(lang) {
    if (!nodes) nodes = collect();
    document.documentElement.lang = lang;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.__de === undefined) el.__de = el.textContent;
      var de = (el.__de || "").trim();
      if (lang === "en" && EN[de] !== undefined) el.textContent = EN[de];
      else el.textContent = el.__de;
    }
    // Gemischte Elemente (mit Inline-Tags): volle englische innerHTML via data-i18n-en.
    var mixed = document.querySelectorAll("[data-i18n-en]");
    for (var m = 0; m < mixed.length; m++) {
      var mx = mixed[m];
      if (mx.__deHtml === undefined) mx.__deHtml = mx.innerHTML;
      mx.innerHTML = lang === "en" ? mx.getAttribute("data-i18n-en") : mx.__deHtml;
    }
    // Titel
    if (!document.__deTitle) document.__deTitle = document.title;
    document.title = (lang === "en" && TITLES[document.__deTitle]) ? TITLES[document.__deTitle] : document.__deTitle;
    // Toggle-Beschriftung
    var t = document.querySelector(".lang-toggle");
    if (t) { t.textContent = lang === "en" ? "DE" : "EN"; t.setAttribute("aria-label", lang === "en" ? "Auf Deutsch umschalten" : "Switch to English"); }
    try { localStorage.setItem(KEY, lang); } catch (e) {}
  }

  function current() {
    try { return localStorage.getItem(KEY) === "en" ? "en" : "de"; } catch (e) { return "de"; }
  }

  function init() {
    var t = document.querySelector(".lang-toggle");
    if (t) t.addEventListener("click", function () { apply(current() === "en" ? "de" : "en"); });
    apply(current());
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
