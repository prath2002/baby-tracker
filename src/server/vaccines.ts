import "server-only";
import { addMonthsClamped, parseCalendarDate } from "@/lib/age";
import type { Q } from "./db";
import { isDisplayable, isPreviewOnly } from "./reference/engine";

/**
 * Due windows are transcribed from the schedule wording in medical_reference_data.json ("At 6 weeks", "9 completed
 * months-12 months", "can be given till one year", ...). Nothing beyond the stated ages is inferred: no overdue
 * thresholds are invented; after the stated maximum age an item is PAST_STATED_AGE_LIMIT ("ask your vaccinator").
 */
type Age = { days?: number; months?: number };
export type DoseDef = {
  code: string; itemId: string; vaccine: string; dose: string; from: Age; to?: Age; maxAge?: Age;
  applicability?: "JE_ENDEMIC_DISTRICTS_ONLY"; effectiveFrom?: string; note?: string; conflict?: string;
};

const W = (w: number): Age => ({ days: w * 7 });
const M = (m: number): Age => ({ months: m });

export const UIP_DOSES: DoseDef[] = [
  { code: "BCG", itemId: "UIP_BCG", vaccine: "BCG", dose: "Birth dose", from: { days: 0 }, maxAge: M(12) },
  { code: "HEPB_BD", itemId: "UIP_HEPB_BD", vaccine: "Hepatitis B", dose: "Birth dose", from: { days: 0 }, maxAge: { days: 1 }, note: "Within 24 hours of birth" },
  { code: "OPV_0", itemId: "UIP_OPV0", vaccine: "OPV", dose: "OPV-0", from: { days: 0 }, maxAge: { days: 15 } },
  ...[1, 2, 3].map((n, i): DoseDef => ({ code: `OPV_${n}`, itemId: "UIP_OPV123", vaccine: "OPV", dose: `OPV-${n}`, from: W([6, 10, 14][i]), maxAge: M(60) })),
  ...[1, 2, 3].map((n, i): DoseDef => ({ code: `PENTA_${n}`, itemId: "UIP_PENTA123", vaccine: "Pentavalent", dose: `Pentavalent-${n}`, from: W([6, 10, 14][i]), maxAge: M(12) })),
  ...[1, 2, 3].map((n, i): DoseDef => ({ code: `RVV_${n}`, itemId: "UIP_RVV", vaccine: "Rotavirus (RVV)", dose: `RVV-${n}`, from: W([6, 10, 14][i]), maxAge: M(12) })),
  { code: "PCV_1", itemId: "UIP_PCV", vaccine: "PCV", dose: "PCV-1", from: W(6) },
  { code: "PCV_2", itemId: "UIP_PCV", vaccine: "PCV", dose: "PCV-2", from: W(14) },
  { code: "PCV_B", itemId: "UIP_PCV", vaccine: "PCV", dose: "PCV booster", from: M(9), to: M(12) },
  { code: "FIPV_1", itemId: "UIP_FIPV12", vaccine: "fIPV", dose: "fIPV-1", from: W(6) },
  { code: "FIPV_2", itemId: "UIP_FIPV12", vaccine: "fIPV", dose: "fIPV-2", from: W(14) },
  { code: "FIPV_3", itemId: "UIP_FIPV3", vaccine: "fIPV", dose: "fIPV-3", from: M(9), effectiveFrom: "2023-01-01", note: "Given with MR-1" },
  { code: "MR_1", itemId: "UIP_MR1", vaccine: "Measles-Rubella (MR)", dose: "MR-1", from: M(9), to: M(12), maxAge: M(60) },
  { code: "JE_1", itemId: "UIP_JE1", vaccine: "Japanese Encephalitis (JE)", dose: "JE-1", from: M(9), to: M(12), applicability: "JE_ENDEMIC_DISTRICTS_ONLY" },
  { code: "VITA_1", itemId: "UIP_VITA1", vaccine: "Vitamin A (supplement)", dose: "1st dose", from: M(9) },
  { code: "DPT_B1", itemId: "UIP_DPTB1", vaccine: "DPT", dose: "DPT booster-1", from: M(16), to: M(24) },
  { code: "MR_2", itemId: "UIP_MR2", vaccine: "Measles-Rubella (MR)", dose: "MR-2", from: M(16), to: M(24), maxAge: M(60) },
  { code: "OPV_B", itemId: "UIP_OPVB", vaccine: "OPV", dose: "OPV booster", from: M(16), to: M(24) },
  { code: "JE_2", itemId: "UIP_JE2", vaccine: "Japanese Encephalitis (JE)", dose: "JE-2", from: M(16), to: M(24), applicability: "JE_ENDEMIC_DISTRICTS_ONLY" },
  { code: "VITA_2_9", itemId: "UIP_VITA29", vaccine: "Vitamin A (supplement)", dose: "2nd–9th doses", from: M(16), to: M(18), note: "Then one dose every 6 months up to 5 years — confirm dates with your health worker" },
  { code: "DPT_B2", itemId: "UIP_DPTB2", vaccine: "DPT", dose: "DPT booster-2", from: M(60), to: M(72) },
  { code: "TET_10Y", itemId: "UIP_TT_TD_10_16", vaccine: "Tetanus-containing booster", dose: "10 years", from: M(120), conflict: "TT vs Td naming under review — confirm with your vaccinator" },
  { code: "TET_16Y", itemId: "UIP_TT_TD_10_16", vaccine: "Tetanus-containing booster", dose: "16 years", from: M(192), conflict: "TT vs Td naming under review — confirm with your vaccinator" },
];

export const IAP_DOSES: DoseDef[] = [
  { code: "IAP_BCG", itemId: "IAP23_BIRTH", vaccine: "BCG", dose: "Birth", from: { days: 0 } },
  { code: "IAP_OPV0", itemId: "IAP23_BIRTH", vaccine: "OPV", dose: "Birth", from: { days: 0 } },
  { code: "IAP_HEPB1", itemId: "IAP23_BIRTH", vaccine: "Hepatitis B", dose: "Hep B-1", from: { days: 0 }, maxAge: { days: 1 } },
  ...["6W", "10W", "14W"].flatMap((lbl, i): DoseDef[] => ["DTwP/DTaP", "IPV", "Hib", "Hep B", "Rotavirus", "PCV"].map((v) => ({
    code: `IAP_${v.replace(/\W/g, "")}_${i + 1}`, itemId: `IAP23_${lbl}`, vaccine: v, dose: `${v}-${v === "Hep B" ? i + 2 : i + 1}`, from: W([6, 10, 14][i]),
    note: v === "Rotavirus" && i === 2 ? "RV1 is a 2-dose schedule; other brands 3 doses" : undefined,
  }))),
  { code: "IAP_IIV1", itemId: "IAP23_6M", vaccine: "Influenza (IIV)", dose: "IIV-1", from: M(6) },
  { code: "IAP_IIV2", itemId: "IAP23_7M", vaccine: "Influenza (IIV)", dose: "IIV-2", from: M(7) },
  { code: "IAP_TCV", itemId: "IAP23_6_9M", vaccine: "Typhoid conjugate", dose: "TCV", from: M(6), to: M(9) },
  { code: "IAP_MMR1", itemId: "IAP23_9M", vaccine: "MMR", dose: "MMR-1", from: M(9) },
  { code: "IAP_HEPA1", itemId: "IAP23_12M", vaccine: "Hepatitis A", dose: "Hep A-1", from: M(12) },
  { code: "IAP_MMR2", itemId: "IAP23_15M", vaccine: "MMR", dose: "MMR-2", from: M(15) },
  { code: "IAP_VAR1", itemId: "IAP23_15M", vaccine: "Varicella", dose: "Varicella-1", from: M(15) },
  { code: "IAP_PCVB", itemId: "IAP23_15M", vaccine: "PCV", dose: "PCV booster", from: M(15) },
  ...["DTwP/DTaP", "Hib", "IPV"].map((v): DoseDef => ({ code: `IAP_${v.replace(/\W/g, "")}_B1`, itemId: "IAP23_16_18M", vaccine: v, dose: `${v}-B1`, from: M(16), to: M(18) })),
  { code: "IAP_HEPA2", itemId: "IAP23_18_19M", vaccine: "Hepatitis A", dose: "Hep A-2 (inactivated only)", from: M(18), to: M(19) },
  { code: "IAP_VAR2", itemId: "IAP23_18_19M", vaccine: "Varicella", dose: "Varicella-2", from: M(18), to: M(19) },
  ...["DTwP/DTaP", "IPV", "MMR"].map((v): DoseDef => ({ code: `IAP_${v.replace(/\W/g, "")}_B2`, itemId: "IAP23_4_6Y", vaccine: v, dose: v === "MMR" ? "MMR-3" : `${v}-B2`, from: M(48), to: M(72) })),
  { code: "IAP_HPV", itemId: "IAP23_9_14Y", vaccine: "HPV", dose: "2 doses (0, 6 mo)", from: M(108), to: M(168) },
  { code: "IAP_TDAP", itemId: "IAP23_10Y", vaccine: "Tdap", dose: "10 years", from: M(120) },
  { code: "IAP_TD", itemId: "IAP23_16_18Y", vaccine: "Td", dose: "16–18 years", from: M(192), to: M(216) },
];

export const SCHEDULES = { GOVERNMENT_OF_INDIA_UIP: UIP_DOSES, IAP_RECOMMENDED_SCHEDULE: IAP_DOSES } as const;
export type ScheduleId = keyof typeof SCHEDULES;

export function ageToDate(birthDate: string, a: Age): string {
  if (a.months !== undefined) return addMonthsClamped(birthDate, a.months);
  return parseCalendarDate(birthDate).plus({ days: a.days ?? 0 }).toISODate()!;
}

export type PlanItem = {
  code: string; schedule_item_id: string; vaccine: string; dose_label: string; due_from: string; due_to: string | null; stated_max_age_date: string | null;
  status: "GIVEN" | "DUE" | "UPCOMING" | "PAST_STATED_AGE_LIMIT" | "NOT_APPLICABLE";
  vaccination_id: string | null; given_on: string | null; notes: string[]; conflict: string | null; preview: boolean; provenance: Record<string, string>;
};

export function buildPlan(opts: {
  scheduleId: ScheduleId; birthDate: string; today: string; jeOptIn: boolean;
  given: { id: string; vaccine_code: string | null; given_on: string }[];
  items: Map<string, { release_gate: string; provenance: Record<string, string> }>;
}): { items: PlanItem[]; pendingReview: number } {
  const out: PlanItem[] = [];
  let pendingReview = 0;
  for (const d of SCHEDULES[opts.scheduleId]) {
    const ref = opts.items.get(d.itemId);
    if (!ref || !isDisplayable(ref.release_gate)) { pendingReview++; continue; }
    const due_from = ageToDate(opts.birthDate, d.from);
    if (d.effectiveFrom && due_from < d.effectiveFrom) continue; // not part of the schedule version in force on that date
    const due_to = d.to ? ageToDate(opts.birthDate, d.to) : null;
    const maxDate = d.maxAge ? ageToDate(opts.birthDate, d.maxAge) : null;
    const g = opts.given.find((x) => x.vaccine_code === d.code);
    let status: PlanItem["status"];
    if (g) status = "GIVEN";
    else if (d.applicability === "JE_ENDEMIC_DISTRICTS_ONLY" && !opts.jeOptIn) status = "NOT_APPLICABLE";
    else if (opts.today < due_from) status = "UPCOMING";
    else if (maxDate && opts.today > maxDate) status = "PAST_STATED_AGE_LIMIT";
    else status = "DUE";
    const notes = [d.note, status === "PAST_STATED_AGE_LIMIT" ? "Past the age stated in the schedule — ask your vaccinator" : undefined,
      d.applicability ? "Only in districts where JE vaccine is offered — ask your health worker" : undefined].filter(Boolean) as string[];
    out.push({
      code: d.code, schedule_item_id: d.itemId, vaccine: d.vaccine, dose_label: d.dose, due_from, due_to, stated_max_age_date: maxDate, status,
      vaccination_id: g?.id ?? null, given_on: g?.given_on ?? null, notes, conflict: d.conflict ?? null, preview: isPreviewOnly(ref.release_gate), provenance: ref.provenance,
    });
  }
  return { items: out.sort((a, b) => a.due_from.localeCompare(b.due_from)), pendingReview };
}

export async function loadScheduleItems(q: Q, scheduleId: ScheduleId) {
  const rows = await q<{ id: string; release_gate: string; payload: { provenance: Record<string, string> } }>(
    "SELECT id, release_gate, payload FROM reference_rule WHERE bucket = $1", [`vaccination:${scheduleId}`]);
  return new Map(rows.map((r) => [r.id, { release_gate: r.release_gate, provenance: r.payload.provenance }]));
}
