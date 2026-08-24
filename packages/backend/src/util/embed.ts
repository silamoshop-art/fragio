/** Gemeinsame Helfer für Widget-Snippet, Vorschau- und Portal-Links. */
import { config } from "../config.js";

/**
 * Öffentliche Basis-URL für alle nach außen sichtbaren Links. Bevorzugt die
 * konfigurierte PUBLIC_BACKEND_URL (Produktion, z. B. https://fragio.at); ohne sie
 * Fallback auf http://localhost:PORT (lokale Entwicklung). Trailing-Slash entfernt.
 */
export function backendBase(): string {
  const base = config.PUBLIC_BACKEND_URL?.trim();
  if (base) return base.replace(/\/+$/, "");
  return `http://localhost:${config.PORT}`;
}

export function snippetFor(botId: string): string {
  return `<script src="${backendBase()}/widget/widget.js" data-bot-id="${botId}" async></script>`;
}

export function previewUrlFor(botId: string): string {
  return `${backendBase()}/preview.html?bot=${botId}`;
}
