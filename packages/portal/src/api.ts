/** Portal-API-Client. Session-Token (an einen Bot gebunden) in localStorage. */
const KEY = "sitebot_portal_token";

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}
export function setToken(t: string): void {
  localStorage.setItem(KEY, t);
}
export function clearToken(): void {
  localStorage.removeItem(KEY);
}

export interface Usage {
  used: number;
  quota: number;
  pct: number;
  status: "ok" | "warn" | "full";
}
export interface Overview {
  botName: string;
  planId: string | null;
  planName: string | null;
  priceCents: number;
  usage: Usage;
  widgetActive: boolean;
}
export type VariantId = "setup" | "commit";
export interface Plan {
  id: "starter" | "business" | "pro";
  name: string;
  limit: number;
  setup: { monthlyCents: number; setupCents: number };
  commit: { monthlyCents: number; commitmentMonths: number };
}
export interface QItem {
  question: string;
  count: number;
}

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  // Session abgelaufen/ungültig (aber NICHT beim Login-Versuch selbst) -> zurück zum Login.
  if (res.status === 401 && !path.endsWith("/login")) {
    clearToken();
    if (typeof window !== "undefined") window.location.reload();
    throw new Error("Sitzung abgelaufen. Bitte erneut anmelden.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    req<{ token: string; botName: string }>("/api/portal/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  overview: () => req<Overview>("/api/portal/overview"),
  plans: () => req<{ plans: Plan[] }>("/api/portal/plans"),
  // Tarif/Variante ANFRAGEN (ändert nichts automatisch — siehe Zahlungsablauf).
  requestPlan: (planId: string, variant: VariantId) =>
    req<{ mode: "request" | "checkout"; message?: string; url?: string }>(
      "/api/portal/plan-request",
      { method: "POST", body: JSON.stringify({ planId, variant }) },
    ),
  analytics: () => req<{ topQuestions: QItem[]; unanswered: QItem[] }>("/api/portal/analytics"),
  snippet: () => req<{ snippet: string; widgetActive: boolean }>("/api/portal/snippet"),
  support: (message: string, replyEmail: string) =>
    req<{ ok: boolean; message: string }>("/api/portal/support", {
      method: "POST",
      body: JSON.stringify({ message, replyEmail }),
    }),
  chatLogs: () => req<PortalChatLog[]>("/api/portal/chat-logs"),
  deleteBySender: (ipHash: string) =>
    req<{ deleted: number }>("/api/portal/chat-logs/delete-by-sender", {
      method: "POST",
      body: JSON.stringify({ ipHash }),
    }),
  addons: () => req<AddonsResp>("/api/portal/addons"),
  requestAddon: (addon: "logo" | "name" | "bundle") =>
    req<{ mode: string; message?: string }>("/api/portal/addon-request", {
      method: "POST",
      body: JSON.stringify({ addon }),
    }),
  // Manuelle FAQs (recrawl-fest)
  listFaqs: () => req<ManualFaq[]>("/api/portal/faqs"),
  createFaq: (body: { question: string; answer: string }) =>
    req<ManualFaq>("/api/portal/faqs", { method: "POST", body: JSON.stringify(body) }),
  updateFaq: (faqId: number, body: { question: string; answer: string }) =>
    req<{ ok: boolean }>(`/api/portal/faqs/${faqId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteFaq: (faqId: number) =>
    req<{ ok: boolean }>(`/api/portal/faqs/${faqId}`, { method: "DELETE" }),
  uploadLogo: async (file: File) => {
    const token = getToken();
    const fd = new FormData();
    fd.append("logo", file);
    const res = await fetch("/api/portal/logo", {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: fd, // KEIN Content-Type setzen -> Browser setzt multipart-Boundary
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
    return data as { ok: boolean; logoUrl: string };
  },
};

export interface ManualFaq {
  id: number;
  bot_id: string;
  question: string;
  answer: string;
  created_at: number;
  updated_at: number;
}

export interface PortalChatLog {
  id: number;
  question: string;
  answered: boolean;
  ipHash: string | null;
  createdAt: number;
}

export type AddonStatus = "active" | "pending" | "available";
export interface AddonsResp {
  logo: { priceCents: number; status: AddonStatus };
  name: { priceCents: number; status: AddonStatus };
  bundle: { priceCents: number; status: AddonStatus };
}
