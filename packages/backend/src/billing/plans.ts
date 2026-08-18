/**
 * Tarife & Preise — jetzt KONFIGURIERBAR über den Settings-Store (app_settings
 * key "pricing"), mit Defaults als Fallback. Admin kann alle Preise ändern,
 * ohne Code-Deploy. Zusätzlich: pro-Kunde-Rabatt (Prozent/Fix) auf den Bot.
 */
import { getSetting, setSetting } from "../db/repo.js";

export type VariantId = "setup" | "commit";
export type PlanId = "starter" | "business" | "pro";

export interface Pricing {
  setupFeeCents: number; // Einrichtungsgebühr (setup-Variante)
  commitMonths: number; // Mindestlaufzeit der commit-Variante
  plans: Record<PlanId, { limit: number; setupMonthlyCents: number; commitMonthlyCents: number }>;
  addons: { logoCents: number; nameCents: number; bundleCents: number };
}

export const DEFAULT_PRICING: Pricing = {
  setupFeeCents: 30000, // 300 €
  commitMonths: 6,
  plans: {
    starter: { limit: 500, setupMonthlyCents: 4900, commitMonthlyCents: 9900 },
    business: { limit: 2000, setupMonthlyCents: 12900, commitMonthlyCents: 17900 },
    pro: { limit: 5000, setupMonthlyCents: 24900, commitMonthlyCents: 29900 },
  },
  addons: { logoCents: 900, nameCents: 500, bundleCents: 1200 },
};

const PLAN_NAMES: Record<PlanId, string> = { starter: "Starter", business: "Business", pro: "Pro" };

/** Effektive Preise: gespeicherte Settings über die Defaults gelegt. */
export function getPricing(): Pricing {
  const raw = getSetting("pricing");
  if (!raw) return DEFAULT_PRICING;
  try {
    const s = JSON.parse(raw) as Partial<Pricing>;
    return {
      setupFeeCents: s.setupFeeCents ?? DEFAULT_PRICING.setupFeeCents,
      commitMonths: s.commitMonths ?? DEFAULT_PRICING.commitMonths,
      plans: {
        starter: { ...DEFAULT_PRICING.plans.starter, ...(s.plans?.starter ?? {}) },
        business: { ...DEFAULT_PRICING.plans.business, ...(s.plans?.business ?? {}) },
        pro: { ...DEFAULT_PRICING.plans.pro, ...(s.plans?.pro ?? {}) },
      },
      addons: { ...DEFAULT_PRICING.addons, ...(s.addons ?? {}) },
    };
  } catch {
    return DEFAULT_PRICING;
  }
}

export function savePricing(p: Pricing): void {
  setSetting("pricing", JSON.stringify(p));
}

export interface PlanVariant {
  monthlyCents: number;
  setupCents: number;
  commitmentMonths: number;
}
export interface PlanDef {
  id: PlanId;
  name: string;
  limit: number;
  setup: PlanVariant;
  commit: PlanVariant;
}

export function getPlanDefs(): PlanDef[] {
  const p = getPricing();
  return (Object.keys(p.plans) as PlanId[]).map((id) => ({
    id,
    name: PLAN_NAMES[id],
    limit: p.plans[id].limit,
    setup: { monthlyCents: p.plans[id].setupMonthlyCents, setupCents: p.setupFeeCents, commitmentMonths: 0 },
    commit: { monthlyCents: p.plans[id].commitMonthlyCents, setupCents: 0, commitmentMonths: p.commitMonths },
  }));
}

export function planById(id: string): PlanDef | undefined {
  return getPlanDefs().find((p) => p.id === id);
}

export function planName(id: string | null | undefined): string {
  return id && PLAN_NAMES[id as PlanId] ? PLAN_NAMES[id as PlanId] : id || "";
}

export function planVariant(planId: string, variant: VariantId): PlanVariant | null {
  const p = planById(planId);
  if (!p) return null;
  return variant === "commit" ? p.commit : p.setup;
}

export function getAddons(): Pricing["addons"] {
  return getPricing().addons;
}

// ── Pro-Kunde-Rabatt ──────────────────────────────────────────────────────────

export type DiscountType = "percent" | "fixed" | null;

/** Effektiven Preis nach individuellem Rabatt berechnen (>= 0). */
export function applyDiscount(baseCents: number, type: DiscountType, value: number): number {
  if (!type || !value) return baseCents;
  const off = type === "percent" ? Math.round((baseCents * value) / 100) : Math.round(value);
  return Math.max(0, baseCents - off);
}
