/** Typisierter API-Client fürs Dashboard. API-Key liegt in localStorage. */

const KEY_STORAGE = "sitebot_api_key";

export function getKey(): string | null {
  return localStorage.getItem(KEY_STORAGE);
}
export function setKey(key: string): void {
  localStorage.setItem(KEY_STORAGE, key);
}
export function clearKey(): void {
  localStorage.removeItem(KEY_STORAGE);
}

export interface Bot {
  id: string;
  name: string;
  status: string;
  llmProvider: "local" | "anthropic" | "openai" | "ollama";
  hasApiKey: boolean;
  chatModel: string | null;
  fallbackToLocal: boolean;
  crawlStartUrl: string | null;
  crawlMaxPages: number;
  lastCrawledAt: number | null;
  allowedOrigins: string[];
  branding: {
    botName?: string;
    primaryColor?: string;
    greeting?: string;
    logoUrl?: string;
  };
  trialMode: boolean;
  trialExpiresAt: number | null;
  trialRequestCount: number;
  trialRequestCap: number;
  chunkCount: number;
  createdAt: number;
  maxInputChars: number;
  maxAnswerTokens: number;
  monthlyQuota: number;
  limitMessage: string | null;
  usage: { used: number; quota: number; period: string };
  lastCrawlStatus: string | null;
  lastCrawlError: string | null;
  plan: string | null;
  priceCents: number;
  basePriceCents: number;
  discountType: "percent" | "fixed" | null;
  discountValue: number;
  isPaying: boolean;
  autoSendInvoice: boolean;
  addonLogo: boolean;
  addonName: boolean;
  privacyText: string | null;
  consent: { count: number; lastAt: number | null };
  customerName: string | null;
  customerAddress: string | null;
  customerEmail: string | null;
  customerVat: string | null;
  retentionDays: number;
  previewUrl: string;
  portalUrl: string;
  portalUser: string | null;
}

export interface Pricing {
  setupFeeCents: number;
  commitMonths: number;
  plans: Record<"starter" | "business" | "pro", { limit: number; setupMonthlyCents: number; commitMonthlyCents: number }>;
  addons: { logoCents: number; nameCents: number; bundleCents: number };
}

export interface Billing {
  billingName: string;
  billingAddress: string;
  billingEmail: string;
  vatId: string;
}

export interface Invoice {
  id: number;
  invoiceNumber: string;
  period: string;
  periodLabel: string;
  amountCents: number;
  currency: string;
  plan: string | null;
  sent: boolean;
  createdAt: number;
}

export interface Analytics {
  total: number;
  answered: number;
  unanswered: number;
  topQuestions: { question: string; count: number }[];
  recentUnanswered: { question: string; created_at: number }[];
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const key = getKey();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) {
    clearKey();
    throw new Error("Nicht autorisiert. Bitte erneut anmelden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export interface PlanRequest {
  id: number;
  botId: string;
  botName: string;
  planId: string;
  planName: string;
  variant: "setup" | "commit";
  monthlyCents: number;
  setupCents: number;
  commitmentMonths: number;
  status: "open" | "done";
  createdAt: number;
}

export const api = {
  me: () => req<{ tenantId: string; email: string; stripeEnabled: boolean }>("/api/admin/me"),
  planRequests: () => req<PlanRequest[]>("/api/admin/plan-change-requests"),
  resolvePlanRequest: (id: number) =>
    req<{ ok: boolean }>(`/api/admin/plan-change-requests/${id}/resolve`, {
      method: "POST",
      body: "{}",
    }),
  getPricing: () => req<Pricing>("/api/admin/pricing"),
  updatePricing: (p: Pricing) =>
    req<Pricing>("/api/admin/pricing", { method: "PATCH", body: JSON.stringify(p) }),
  listBots: () => req<Bot[]>("/api/admin/bots"),
  createBot: (body: { name: string; startUrl?: string; maxPages?: number }) =>
    req<Bot>("/api/admin/bots", { method: "POST", body: JSON.stringify(body) }),
  getBot: (id: string) => req<Bot>(`/api/admin/bots/${id}`),
  updateBot: (id: string, patch: Record<string, unknown>) =>
    req<Bot>(`/api/admin/bots/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteBot: (id: string) =>
    req<{ ok: boolean }>(`/api/admin/bots/${id}`, { method: "DELETE" }),
  analytics: (id: string) => req<Analytics>(`/api/admin/bots/${id}/analytics`),
  snippet: (id: string) => req<{ snippet: string }>(`/api/admin/bots/${id}/snippet`),
  // Billing
  getBilling: () => req<Billing>("/api/admin/billing"),
  updateBilling: (patch: Partial<Billing>) =>
    req<{ ok: boolean }>("/api/admin/billing", { method: "PATCH", body: JSON.stringify(patch) }),
  listInvoices: (botId: string) => req<Invoice[]>(`/api/admin/bots/${botId}/invoices`),
  createInvoice: (botId: string) =>
    req<{ created: boolean; invoice: Invoice | null }>(`/api/admin/bots/${botId}/invoice`, {
      method: "POST",
      body: "{}", // leerer Body -> Fastify-JSON-Parser wirft sonst 400
    }),
  proration: (botId: string) =>
    req<{ cents: number; remainingDays: number; daysInMonth: number }>(
      `/api/admin/bots/${botId}/proration`,
    ),
  createExtraInvoice: (botId: string, body: { amountCents: number; description: string; periodLabel?: string }) =>
    req<{ created: boolean; invoice: Invoice | null }>(`/api/admin/bots/${botId}/extra-invoice`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  setPortalUser: (botId: string, body: { email: string; password?: string }) =>
    req<{ email: string; password?: string; portalUrl: string }>(
      `/api/admin/bots/${botId}/portal-user`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  // Offene Zahlungen (Section D)
  chatLogs: (botId: string) => req<ChatLogEntry[]>(`/api/admin/bots/${botId}/chat-logs`),
  deleteBySender: (botId: string, ipHash: string) =>
    req<{ deleted: number }>(`/api/admin/bots/${botId}/chat-logs/delete-by-sender`, {
      method: "POST",
      body: JSON.stringify({ ipHash }),
    }),
  openPayments: () => req<OpenPayment[]>("/api/admin/open-payments"),
  markInvoicePaid: (invoiceId: number) =>
    req<{ ok: boolean }>(`/api/admin/invoices/${invoiceId}/paid`, { method: "POST", body: "{}" }),
  sendReminder: (invoiceId: number) =>
    req<{ ok: boolean; sentTo: string; attached: boolean }>(
      `/api/admin/invoices/${invoiceId}/reminder`,
      { method: "POST", body: "{}" },
    ),
};

export interface ChatLogEntry {
  id: number;
  question: string;
  answered: boolean;
  ipHash: string | null;
  createdAt: number;
}

export interface OpenPayment {
  id: number;
  invoiceNumber: string;
  botId: string;
  botName: string;
  customerName: string | null;
  customerEmail: string | null;
  periodLabel: string;
  amountCents: number;
  currency: string;
  dueDate: number;
  overdue: boolean;
  reminderSentAt: number | null;
}

/** Rechnungs-PDF mit Auth laden und im neuen Tab öffnen (a[href] kann keinen Header senden). */
export async function openInvoicePdf(invoiceId: number): Promise<void> {
  const key = getKey();
  const res = await fetch(`/api/admin/invoices/${invoiceId}/pdf`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw new Error(`PDF konnte nicht geladen werden (HTTP ${res.status}).`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** SSE-POST für Recrawl-Fortschritt. */
export function recrawl(
  botId: string,
  on: { progress: (p: any) => void; ready: (r: any) => void; error: (m: string) => void },
): void {
  const key = getKey();
  fetch(`/api/admin/bots/${botId}/recrawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: "{}", // leerer Body -> Fastify-JSON-Parser wirft sonst 400
  })
    .then((res) => {
      if (!res.ok || !res.body) return on.error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const pump = (): Promise<void> =>
        reader.read().then((r) => {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let ev = "message";
            let data = "";
            raw.split("\n").forEach((line) => {
              if (line.startsWith("event:")) ev = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trim();
            });
            let p: any = {};
            try {
              p = data ? JSON.parse(data) : {};
            } catch {
              /* ignore */
            }
            if (ev === "progress") on.progress(p);
            else if (ev === "ready") on.ready(p);
            else if (ev === "error") on.error(p.message || "Fehler");
          }
          return pump();
        });
      return pump();
    })
    .catch((e) => on.error(String(e)));
}
