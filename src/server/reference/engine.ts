import "server-only";
import type { Q } from "../db";
import { referencePreview } from "../env";

/**
 * Medical reference engine (spec §19–20). Resolves applicable rules by population × context × release gate.
 * Never multiplies a clinical ml/kg/day value into a personal target. Personal numbers only come from FeedingPlan.
 */
export type RuleRow = { id: string; bucket: string; source_id: string; population: string; clinical_context: string; payload: Record<string, unknown>; release_gate: string };
export type Provenance = Record<string, string>;
export type ReferenceStatus =
  | "NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND" | "NOT_ESTABLISHED" | "CLINICAL_REFERENCE" | "CARE_TEAM_PLAN"
  | "CONFLICT_REQUIRES_REVIEW" | "REFERENCE_UNAVAILABLE_INVALID_PROFILE";

export type BabyFacts = {
  ageDays: number;
  dayOfLife: number;
  birthWeightKg: number | null;
  latestWeightKg: number | null;
  gaWeeks: number | null;
  gaUnknown: boolean;
  unableToBreastfeed: boolean | null;
  showClinicalReferences: boolean;
};

export type Populations = {
  lbw: boolean | null; vlbw: boolean | null; lt1200: boolean | null; preterm: boolean | null; veryPreterm: boolean | null; termKnown: boolean;
};

/** WHO 2022 definitions: preterm < 37 wk; very preterm < 32 wk; LBW < 2.5 kg; VLBW < 1.5 kg. Unknown stays null. */
export function derivePopulations(f: Pick<BabyFacts, "birthWeightKg" | "gaWeeks" | "gaUnknown">): Populations {
  const bw = f.birthWeightKg;
  const ga = f.gaUnknown ? null : f.gaWeeks;
  return {
    lbw: bw === null ? null : bw < 2.5,
    vlbw: bw === null ? null : bw < 1.5,
    lt1200: bw === null ? null : bw < 1.2,
    preterm: ga === null ? null : ga < 37,
    veryPreterm: ga === null ? null : ga < 32,
    termKnown: ga !== null && ga >= 37,
  };
}

export function categoriesOf(p: Populations): string[] {
  const out: string[] = [];
  if (p.preterm) out.push("PRETERM_LT_37W");
  if (p.veryPreterm) out.push("VERY_PRETERM_LT_32W");
  if (p.lbw) out.push("LOW_BIRTH_WEIGHT_LT_2500G");
  if (p.vlbw) out.push("VLBW_LT_1500G");
  return out;
}

/** Rules that are facility/clinician-only and never appear in parent mode (spec §12–13). */
export const CLINICIAN_ONLY = new Set(["CFR_NHM_TROPHIC_LT1200", "CFR_WHO2022_A8_ADVANCE", "FG_WHO2022_A7_SCHEDULED", "FG_WHO2022_A6_EARLY_ENTERAL"]);

export const isDisplayable = (gate: string) => gate === "CLEARED" || referencePreview();
export const isPreviewOnly = (gate: string) => gate !== "CLEARED";

function num(v: unknown): number | null { return typeof v === "number" ? v : null; }

/** Does a clinical feeding rule apply to this baby right now? Pure, testable. */
export function clinicalRuleApplies(rule: RuleRow, f: BabyFacts): boolean {
  const p = rule.payload;
  const pops = derivePopulations(f);
  const within = (v: number | null, min: number | null, maxExcl: number | null, maxIncl?: number | null) =>
    v !== null && (min === null || v >= min) && (maxExcl === null || v < maxExcl) && (maxIncl == null || v <= maxIncl);
  if (rule.id.startsWith("CFR_NHM_FLUID_")) {
    if (pops.lbw !== true) return false;
    if (!within(f.birthWeightKg, num(p.birth_weight_min_kg), num(p.birth_weight_max_kg_exclusive))) return false;
    return within(f.dayOfLife, num(p.day_of_life_min), null, num(p.day_of_life_max));
  }
  if (rule.id === "CFR_NHM_STABLE_LBW_ADVANCE") return pops.lbw === true && f.dayOfLife >= 8;
  if (rule.id === "CFR_NHM_TROPHIC_LT1200") return pops.lt1200 === true;
  if (rule.id === "CFR_WHO_HEPNFS_GE2500_CANNOT_BF") return f.unableToBreastfeed === true && (f.latestWeightKg ?? f.birthWeightKg ?? 0) >= 2.5;
  if (rule.id.startsWith("CFR_WHO_HEPNFS_LT2500")) return f.unableToBreastfeed === true && pops.lbw === true;
  if (rule.id === "CFR_WHO2022_A8_ADVANCE") return pops.vlbw === true || pops.veryPreterm === true;
  return false;
}

export function provenanceOf(rule: RuleRow): Provenance {
  return (rule.payload.provenance as Provenance) ?? {};
}

export type FeedingPlanRow = { id: string; clinician_name: string; instructed_on: string; plan_text: string; volume_ml_per_feed: string | null; feeds_per_day: number | null; entered_from: string };

export type ReferenceResult = {
  reference_status: ReferenceStatus;
  display_mode: string;
  messages: string[];
  guidance: { id: string; text: string; provenance: Provenance; preview: boolean }[];
  rules: { rule_id: string; label: "Clinical reference"; population: string; clinical_context: string; value_min: number | null; value_max: number | null; value_target: number | null; unit: string | null; frequency: string | null; warnings: string[]; provenance: Provenance; preview: boolean }[];
  plan: FeedingPlanRow | null;
  pending_review: string[];
  preview_mode: boolean;
};

export function resolveReference(rules: RuleRow[], f: BabyFacts, method: string, plan: FeedingPlanRow | null, viewer: "PARENT" | "CLINICIAN" = "PARENT"): ReferenceResult {
  const out: ReferenceResult = { reference_status: "NOT_ESTABLISHED", display_mode: "NONE", messages: [], guidance: [], rules: [], plan, pending_review: [], preview_mode: referencePreview() };
  const byId = new Map(rules.map((r) => [r.id, r]));
  const pops = derivePopulations(f);

  // Parent guidance text (WHO responsive feeding) — shown only when released (or in preview).
  for (const gid of ["FG_WHO_RESPONSIVE", "FG_WHO_EBF_6M"]) {
    const g = byId.get(gid);
    if (!g) continue;
    if (isDisplayable(g.release_gate)) out.guidance.push({ id: g.id, text: String(g.payload.statement ?? ""), provenance: provenanceOf(g), preview: isPreviewOnly(g.release_gate) });
    else out.pending_review.push(g.id);
  }

  const candidates = rules.filter((r) => r.bucket === "clinical_feeding_rules" && clinicalRuleApplies(r, f) && (viewer === "CLINICIAN" || !CLINICIAN_ONLY.has(r.id)));
  const shownClinical = candidates.filter((r) => isDisplayable(r.release_gate));
  candidates.filter((r) => !isDisplayable(r.release_gate)).forEach((r) => out.pending_review.push(r.id));

  if (plan) {
    out.reference_status = "CARE_TEAM_PLAN";
    out.display_mode = "CARE_TEAM_PLAN";
    out.messages.push(`Following the care-team plan recorded from ${plan.clinician_name} (${plan.instructed_on}).`);
  }

  const clinicalVisible = viewer === "CLINICIAN" || f.showClinicalReferences;
  if (clinicalVisible && shownClinical.length) {
    for (const r of shownClinical) {
      const p = r.payload;
      out.rules.push({
        rule_id: r.id, label: "Clinical reference", population: r.population, clinical_context: r.clinical_context,
        value_min: num(p.value_min), value_max: num(p.value_max), value_target: num(p.value_target), unit: (p.unit as string) ?? null,
        frequency: (p.frequency as string) ?? null, warnings: [...((p.warnings as string[]) ?? []), "Individual feeding targets should follow the baby's pediatric/neonatal care team."],
        provenance: provenanceOf(r), preview: isPreviewOnly(r.release_gate),
      });
    }
    const issuers = new Set(shownClinical.map((r) => r.source_id));
    if (!plan) {
      out.reference_status = issuers.size > 1 ? "CONFLICT_REQUIRES_REVIEW" : "CLINICAL_REFERENCE";
      out.display_mode = issuers.size > 1 ? "CONFLICT" : "CLINICAL_REFERENCE_CARD";
    }
  }

  if (!plan && out.rules.length === 0) {
    const healthyTermOrBf = method === "DIRECT_BREASTFEEDING" || method === "ANY" || (pops.lbw === false && pops.preterm !== true);
    if (healthyTermOrBf && pops.lbw !== true && pops.preterm !== true) {
      out.reference_status = "NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND";
      out.display_mode = "RESPONSIVE_FEEDING_MESSAGE";
      out.messages.push("No universal milk amount applies to healthy babies. Breastfeed responsively/on demand.");
      out.messages.push("Direct breastfeeding volume cannot be reliably measured from duration alone.");
      out.messages.push("Track feeding frequency, weight and other relevant observations, and discuss any concerns with your pediatrician.");
    } else {
      out.reference_status = "NOT_ESTABLISHED";
      out.display_mode = "NOT_ESTABLISHED";
      out.messages.push(pops.lbw || pops.preterm
        ? "Follow your baby's care-team feeding plan. You can record it here so it shows on your summaries."
        : "No authoritative reference applies to this situation. Discuss with your pediatrician.");
    }
  }
  if (out.pending_review.length) out.messages.push("Some reference guidance is pending clinical review and is not shown yet.");
  return out;
}

export async function loadRules(q: Q, buckets: string[] = ["feeding_guidelines", "clinical_feeding_rules", "breastfeeding_adequacy_indicators", "complementary_feeding"]): Promise<RuleRow[]> {
  return q<RuleRow>("SELECT id, bucket, source_id, population, clinical_context, payload, release_gate FROM reference_rule WHERE bucket = ANY($1)", [buckets]);
}
