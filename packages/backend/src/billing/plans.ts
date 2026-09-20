/**
 * Tarife & Preise — jetzt KONFIGURIERBAR über den Settings-Store (app_settings
 * key "pricing"), mit Defaults als Fallback. Admin kann alle Preise ändern,
 * ohne Code-Deploy. Zusätzlich: pro-Kunde-Rabatt (Prozent/Fix) auf den Bot.
 */
import { getSetting, setSetting } from "../db/repo.js";

export type VariantId = "setup" | "commit";
export type PlanId = "starter" | "business" | "pro";

export interface Pricing {
  setupFeeEnabled: boolean; // Einrichtungsgebühr aktiv? (sonst 0 € für Neukunden)
  setupFeeCents: number; // Einrichtungsgebühr (setup-Variante)
  commitMonths: number; // Mindestlaufzeit der commit-Variante
  plans: Record<PlanId, { limit: number; setupMonthlyCents: number; commitMonthlyCents: number }>;
  addons: { logoCents: number; nameCents: number; bundleCents: number };
}

export const DEFAULT_PRICING: Pricing = {
  // Neue Staffel (Interessenten-Feedback): niedriger laufender Preis + separat
  // ausgewiesene Einrichtungsgebühr; höhere, realistischere Kontingente.
  setupFeeEnabled: true, // Einrichtungsgebühr wird ausgewiesen
  setupFeeCents: 25000, // 250 € Standard-Einrichtung
  commitMonths: 6,
  plans: {
    // setup-Variante = monatlich + einmalige Einrichtung; commit = gleiche Monatsrate,
    // dafür 6 Monate Bindung statt Einrichtungsgebühr.
    starter: { limit: 500, setupMonthlyCents: 2900, commitMonthlyCents: 2900 },
    business: { limit: 2500, setupMonthlyCents: 7900, commitMonthlyCents: 7900 },
    pro: { limit: 10000, setupMonthlyCents: 19900, commitMonthlyCents: 19900 },
  },
  addons: { logoCents: 900, nameCents: 500, bundleCents: 1200 },
};

// Basis / Standard / Betreut (interne IDs bleiben starter/business/pro stabil).
const PLAN_NAMES: Record<PlanId, string> = { starter: "Basis", business: "Standard", pro: "Betreut" };

/** Jahresvorauszahlung (Anforderung B): 2 Monate geschenkt → 10 statt 12 zahlen. */
export const ANNUAL_FREE_MONTHS = 2;
/** Preisgarantie ab Vertragsbeginn in Monaten (Anforderung B). */
export const PRICE_GUARANTEE_MONTHS = 12;
/** Betrag für ein Jahr im Voraus (mit Freimonaten). */
export function annualCents(monthlyCents: number): number {
  return monthlyCents * (12 - ANNUAL_FREE_MONTHS);
}

/** Effektive Preise: gespeicherte Settings über die Defaults gelegt. */
export function getPricing(): Pricing {
  const raw = getSetting("pricing");
  if (!raw) return DEFAULT_PRICING;
  try {
    const s = JSON.parse(raw) as Partial<Pricing>;
    return {
      setupFeeEnabled: s.setupFeeEnabled ?? DEFAULT_PRICING.setupFeeEnabled,
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

/** Rangfolge der Tarife (für Upgrade-/Downgrade-Logik im Portal). */
export const PLAN_ORDER: PlanId[] = ["starter", "business", "pro"];
export function planRank(id: string | null | undefined): number {
  const i = PLAN_ORDER.indexOf(id as PlanId);
  return i < 0 ? -1 : i;
}

/**
 * Enthält der Tarif das Branding (eigenes Logo + Bot-Name) bereits? Der Pro-Tarif
 * beinhaltet es laut Website — dann werden die Branding-Zusatzoptionen NICHT als
 * separate (kostenpflichtige) Upsells angeboten, und der Logo-Upload ist frei.
 */
export function planIncludesBranding(plan: string | null | undefined): boolean {
  // Ab „Standard" (business) ist eigenes Branding (Logo + Bot-Name) inklusive.
  return plan === "business" || plan === "pro";
}

// ── Pro-Kunde-Rabatt ──────────────────────────────────────────────────────────

export type DiscountType = "percent" | "fixed" | null;

/** Effektiven Preis nach individuellem Rabatt berechnen (>= 0). */
export function applyDiscount(baseCents: number, type: DiscountType, value: number): number {
  if (!type || !value) return baseCents;
  const off = type === "percent" ? Math.round((baseCents * value) / 100) : Math.round(value);
  return Math.max(0, baseCents - off);
}
