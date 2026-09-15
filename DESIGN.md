# DESIGN.md — Fragio Design-System

Dokumentiert das committete visuelle System der Website (`packages/landing/public`).
Quelle der Wahrheit ist `site.css` (`:root`-Tokens). Änderungen bitte zentral über die
Tokens, nicht per Inline-Hardcode.

## Modus & Haltung

Persuade (Marketing/Landing): Aufmerksamkeit und Handlung verdienen. Ruhiges,
vertrauenswürdiges Blau-Neutral; Klarheit vor Effekt. „Ehrlich statt Blackbox" ist die
Marken-Kernaussage — der Ton bleibt sachlich, nie marktschreierisch.

## Farbe (oklch-Tokens, `site.css :root`)

| Token | Wert | Zweck |
|---|---|---|
| `--bg` | oklch(0.985 0.003 258) | Seitenhintergrund (off-white) |
| `--surface` / `--surface-2` | #fff / oklch(0.968 …) | Karten / abgesetzte Flächen |
| `--ink` | oklch(0.22 0.01 258) | Fließtext/Überschriften |
| `--muted` | oklch(0.46 0.01 258) | Sekundärtext (AA-konform) |
| `--muted-2` | oklch(0.53 0.012 258) | Tertiärtext — **auf ≥4.5:1 gehoben (WCAG AA)** |
| `--line` / `--line-2` | oklch(0.92 …) / oklch(0.88 …) | Rahmen/Trenner |
| `--accent` / `--accent-dark` | oklch(0.55 0.16 258) / 0.48 | Primärblau (Buttons, Links, Fokus) |
| `--accent-soft` | oklch(0.95 0.03 258) | Tönung (Auswahl, aktive Chips, Flag-Blase) |
| `--danger` | oklch(0.55 0.18 25) | Fehler |

Kontrast ist Pflicht: Body/Placeholder ≥ 4.5:1. `--muted-2` wurde deshalb abgedunkelt.
Sekundärtext auf farbigen Flächen aus der Hue tönen, nie neutrales Grau.

## Typografie

System-Sans-Stack (`--sans`), kein Web-Font (bewusst: keine Drittanbieter-Übermittlung,
DSGVO). Überschriften `letter-spacing: -0.02em`, `line-height: 1.12`, `text-wrap: pretty`.
Hero-H1 `clamp(36px,5.4vw,62px)`. Body 16px/1.6. **Kein Eyebrow/Kicker über Überschriften**
(bewusst entfernt — die H1 trägt sich selbst).

## Motion (Emil-Kowalski-Prinzipien)

- Eigene Easing-Tokens: `--ease-out` (exponentielles Ausklingen), `--ease-in-out`, `--ease-spring` (dezent, ohne starkes Overshoot).
- UI-Übergänge < 300 ms; nur `transform`/`opacity`/`filter` animieren.
- Buttons: `scale(0.97)` beim `:active`. Hover-Lift nur hinter `@media (hover:hover) and (pointer:fine)`.
- Scroll-Reveal: `translateY(16px)` + `blur(6px)` → scharf, gestaffelt über `data-reveal="<ms>"`; JS-Sicherheitsnetz macht nach 1700 ms garantiert sichtbar. Respektiert `prefers-reduced-motion`.
- Genau **ein** authored Moment pro Fläche; die Scraping-Animation (Scan-Bar + Puls) ist bewusst funktional (zeigt aktiven Crawl).

## Komponenten (Klassen in `site.css`)

- **Buttons:** `.btn` + `.btn-primary` / `.btn-ghost` / `.btn-accent` / `.btn-ghost-light`, `.btn-sm`, `.btn-block`. Primär hat echte Tiefe (Offset+Blur, kein Halo).
- **Header/Nav:** `.site-header` (sticky, backdrop-blur), `.nav`, `.brand` + `.brand-mark` (echtes Bot-Maskottchen `logo-mark.png`), `.nav-links`, `.lang-toggle`, `.nav-toggle` (mobil; `aria-expanded`/`aria-controls`, Escape schließt).
- **Layout:** `.wrap` (max 1160px), `.section`(.alt), `.section-head`, `.grid-3`, `.card` (+`.lift`).
- **Hero:** `.hero`, `.hero-grid`, `.chat-card` (Chat-Mockup).
- **Preise:** `.price-card`(.featured), gezeichnetes Häkchen (kein Unicode-Glyph).
- **FAQ:** `<details>/.faq-item`, Marker als gezeichnetes Plus→Minus (kein `+`/`–`-Glyph).
- **Formular/Bestellung:** `.form`, `.plan-opt`, `.summary-box`, `.pay-box`, `.success-check`.
- **Recht/Prosa:** `.page-head`, `.prose`, `.toc`, `.callout`.

## Browser-Oberflächen (aus der Palette gethemt)

`::selection`, Scrollbar, `caret-color`, `accent-color`, Fokus-Ring (`:focus-visible`,
`outline-offset:3px`), `scroll-padding-top:76px` (Sticky-Header verdeckt sonst Anker/Fokus,
WCAG 2.2 AA 2.4.11). `[hidden]{display:none!important}` (schlägt Inline-`display`).

## Anti-Slop-Regeln (bewusst befolgt)

Keine Gradient-Text, keine Glas/Blur-Deko, kein farbiger `border-left > 1px` auf Karten/
Callouts, keine Unicode-Glyphen/Emoji als Icons (alle Icons gezeichnet/SVG), keine
großen Deko-Zahlen als Fake-Inhalt. Karten-Schatten gestrafft (kein diffuser „AI-Card"-Halo).

## Dark Mode

Aktuell bewusst Single-Look (heller Marketing-Kontext). Bei späterer Dark-Variante:
Tokens auf bare `:root` als Light definieren, unter `@media (prefers-color-scheme: dark)`
+ `:root[data-theme="dark"]` neu belegen.
