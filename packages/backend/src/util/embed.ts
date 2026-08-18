/** Gemeinsame Helfer für Widget-Snippet, Vorschau- und Portal-Links. */
import { config } from "../config.js";

export function backendBase(): string {
  return config.isProd ? "https://<DEIN-BACKEND-HOST>" : `http://localhost:${config.PORT}`;
}

export function snippetFor(botId: string): string {
  return `<script src="${backendBase()}/widget/widget.js" data-bot-id="${botId}" async></script>`;
}

export function previewUrlFor(botId: string): string {
  return `${backendBase()}/preview.html?bot=${botId}`;
}
