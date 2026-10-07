export const ICON: Record<string, string> = { BIRTH: "🌱", FEEDING: "🍼", EXCRETION: "💧", WEIGHT: "⚖︎", VACCINE: "💉", APPOINTMENT: "📅", PRESCRIPTION: "📝", MEDICINE: "💊", ALLERGY: "⚠︎", MEDICAL_REPORT: "📄", IMPORTANT_MEDICAL_EVENT: "⭐", CUSTOM: "✎" };

export type ExcretionType = "URINE" | "STOOL" | "URINE_AND_STOOL" | "VOMIT";
export const EXCRETION_LABEL: Record<ExcretionType, string> = { URINE: "Pee", STOOL: "Poop", URINE_AND_STOOL: "Pee + poop", VOMIT: "Vomit" };
export const EXCRETION_ICON: Record<ExcretionType, string> = { URINE: "💧", STOOL: "💩", URINE_AND_STOOL: "💧💩", VOMIT: "🤮" };

/** "6 wet · 3 dirty · 1 vomit" — a diaper with both counts as wet and dirty. Counts only, never judged against a threshold. */
export function excretionCounts(types: (string | null | undefined)[]) {
  const c = { wet: 0, dirty: 0, vomit: 0 };
  for (const t of types) {
    if (t === "URINE" || t === "URINE_AND_STOOL") c.wet++;
    if (t === "STOOL" || t === "URINE_AND_STOOL") c.dirty++;
    if (t === "VOMIT") c.vomit++;
  }
  return c;
}
export function excretionCountText(types: (string | null | undefined)[]) {
  const c = excretionCounts(types);
  return [`${c.wet} wet`, `${c.dirty} dirty`, c.vomit ? `${c.vomit} vomit` : null].filter(Boolean).join(" · ");
}
