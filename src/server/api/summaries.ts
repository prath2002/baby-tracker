import "server-only";
import { DateTime } from "luxon";
import { calculateBabyAge, localDateOf, parseCalendarDate } from "@/lib/age";
import { calculateRangeMeasuredMilk, calculateFeedingFrequency } from "@/lib/milk";
import { badRequest, type Ctx, type Router } from "../http";
import { requireBaby, type BabyAccess } from "../core";
import { dailyFeedingSummary, feedsInRange, applicableReference } from "./feedings";
import { vaccinePlan } from "./vaccinations";
import { excretionCounts } from "./excretions";

export function datesBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = parseCalendarDate(from); d.toISODate()! <= to; d = d.plus({ days: 1 })) out.push(d.toISODate()!);
  return out;
}

async function common(ctx: Ctx, a: BabyAccess, from: string, to: string) {
  const fromTs = DateTime.fromISO(from, { zone: a.householdTz }).startOf("day").toUTC().toISO();
  const toTs = DateTime.fromISO(to, { zone: a.householdTz }).endOf("day").toUTC().toISO();
  const docs = a.canViewDocuments || a.role === "OWNER" || a.role === "GUARDIAN";
  return {
    weights: await ctx.q(`SELECT id, to_char(local_date,'YYYY-MM-DD') AS local_date, weight_kg::float, length_cm::float, head_circumference_cm::float, measurement_source FROM weight_measurement
      WHERE baby_id = $1 AND deleted_at IS NULL AND local_date BETWEEN $2 AND $3 ORDER BY measured_at`, [a.babyId, from, to]),
    latest_weight_before: await ctx.q.one(`SELECT to_char(local_date,'YYYY-MM-DD') AS local_date, weight_kg::float FROM weight_measurement WHERE baby_id = $1 AND deleted_at IS NULL AND weight_kg IS NOT NULL AND local_date < $2 ORDER BY measured_at DESC LIMIT 1`, [a.babyId, from]),
    vaccinations: await ctx.q(`SELECT id, vaccine_name_as_recorded, dose_label, to_char(given_on,'YYYY-MM-DD') AS given_on FROM vaccination WHERE baby_id = $1 AND deleted_at IS NULL AND given_on BETWEEN $2 AND $3 ORDER BY given_on`, [a.babyId, from, to]),
    appointments: await ctx.q(`SELECT a.id, a.starts_at, a.purpose, a.status, d.name AS doctor_name FROM appointment a LEFT JOIN doctor d ON d.id = a.doctor_id WHERE a.baby_id = $1 AND a.deleted_at IS NULL AND a.starts_at BETWEEN $2 AND $3 ORDER BY a.starts_at`, [a.babyId, fromTs, toTs]),
    medicines: await ctx.q(`SELECT id, medicine_name, status, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
      (SELECT count(*)::int FROM medicine_dose d WHERE d.medicine_id = m.id AND d.status = 'GIVEN' AND coalesce(d.given_at, d.recorded_at) BETWEEN $2 AND $3) AS doses_given,
      (SELECT count(*)::int FROM medicine_dose d WHERE d.medicine_id = m.id AND d.scheduled_for BETWEEN $2 AND $3) AS doses_scheduled_recorded
      FROM medicine m WHERE baby_id = $1 AND deleted_at IS NULL AND start_date <= $5 AND (end_date IS NULL OR end_date >= $4) ORDER BY start_date`, [a.babyId, fromTs, toTs, from, to]),
    allergies: await ctx.q("SELECT substance, status, severity_reported, reaction_text FROM allergy WHERE baby_id = $1 AND is_active AND deleted_at IS NULL", [a.babyId]),
    documents: docs ? await ctx.q(`SELECT id, title, doc_type, to_char(document_date,'YYYY-MM-DD') AS document_date FROM medical_document WHERE baby_id = $1 AND deleted_at IS NULL AND scan_status = 'CLEAN' AND doc_type <> 'PHOTO'
      AND coalesce(document_date, created_at::date) BETWEEN $2 AND $3 ORDER BY document_date`, [a.babyId, from, to]) : [],
    highlights: await ctx.q(`SELECT event_type, occurred_at, title FROM timeline_event WHERE baby_id = $1 AND NOT is_hidden AND event_type NOT IN ('FEEDING','EXCRETION') ${docs ? "" : "AND event_type <> 'MEDICAL_REPORT'"}
      AND occurred_at BETWEEN $2 AND $3 ORDER BY importance DESC, occurred_at LIMIT 20`, [a.babyId, fromTs, toTs]),
  };
}

export async function rangeSummary(ctx: Ctx, a: BabyAccess, from: string, to: string, period: string) {
  const today = localDateOf(new Date(), a.householdTz);
  const end = to > today ? today : to;
  const dates = end >= from ? datesBetween(from < a.baby.birth_date ? a.baby.birth_date : from, end) : [];
  const feeds = dates.length ? await feedsInRange(ctx, a.babyId, dates[0], dates[dates.length - 1]) : [];
  const milk = calculateRangeMeasuredMilk(feeds, dates);
  const c = await common(ctx, a, from, to);
  const ws = (c.weights as { weight_kg: number | null; local_date: string }[]).filter((w) => w.weight_kg != null);
  const first = (c.latest_weight_before as { weight_kg: number; local_date: string } | null) ?? ws[0];
  const last = ws[ws.length - 1];
  const weightTrend = first && last && first !== last
    ? { from: first, to: last, delta_g: Math.round((last.weight_kg! - first.weight_kg!) * 1000), days: Math.round((Date.parse(last.local_date) - Date.parse(first.local_date)) / 86_400_000) }
    : null;
  const notes: string[] = [];
  if (dates.length) notes.push(`Feeds recorded on ${milk.daysWithAnyData} of ${dates.length} days.`);
  if (milk.daysWithMeasuredData) notes.push(`Average measured milk is over ${milk.daysWithMeasuredData} day(s) with measured feeds.`);
  const srcCounts = (c.weights as { measurement_source: string }[]).reduce<Record<string, number>>((m, w) => ((m[w.measurement_source] = (m[w.measurement_source] ?? 0) + 1), m), {});
  if (Object.keys(srcCounts).length) notes.push("Weights from " + Object.entries(srcCounts).map(([k, n]) => `${k.toLowerCase().replace("_", " ")} ×${n}`).join(", ") + ".");
  let vaccines = null;
  try { vaccines = await vaccinePlan(ctx, a); } catch { vaccines = null; }
  return {
    baby_id: a.babyId, period, from, to, age: calculateBabyAge({ birthDate: a.baby.birth_date }, new Date(), a.householdTz),
    feeding: { ...milk, median_interval_min: calculateFeedingFrequency(feeds).medianIntervalMin },
    excretions: dates.length ? await excretionCounts(ctx, a.babyId, dates[0], dates[dates.length - 1]) : { wet: 0, dirty: 0, vomit: 0, total: 0, last_at: null },
    weight_trend: weightTrend, ...c,
    vaccine_plan: vaccines ? { schedule_id: vaccines.schedule_id, due: vaccines.items.filter((i) => i.status === "DUE" || i.status === "PAST_STATED_AGE_LIMIT"), pending_review: vaccines.pendingReview } : null,
    reference: await applicableReference(ctx, a),
    data_quality_notes: notes,
    disclaimer: "Generated from parent-entered records. Reference information only; not a substitute for pediatric care.",
  };
}

export function registerSummaries(r: Router) {
  r.get("/babies/:babyId/summaries/daily", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const date = ctx.query.get("date") ?? localDateOf(new Date(), a.householdTz);
    parseCalendarDate(date);
    const base = await rangeSummary(ctx, a, date, date, "DAILY");
    return { ...base, today: await dailyFeedingSummary(ctx, a, date) };
  });
  r.get("/babies/:babyId/summaries/weekly", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const week = ctx.query.get("week");
    let start: DateTime;
    if (week) {
      const m = week.match(/^(\d{4})-W(\d{2})$/);
      if (!m) throw badRequest("week must look like 2026-W41");
      start = DateTime.fromObject({ weekYear: Number(m[1]), weekNumber: Number(m[2]), weekday: 1 });
      if (!start.isValid) throw badRequest("Invalid ISO week");
    } else if (ctx.query.get("rolling") === "true") {
      start = DateTime.fromISO(localDateOf(new Date(), a.householdTz)).minus({ days: 6 });
    } else start = DateTime.fromISO(localDateOf(new Date(), a.householdTz)).startOf("week");
    const from = start.toISODate()!, to = start.plus({ days: 6 }).toISODate()!;
    return rangeSummary(ctx, a, from, to, week ?? `${start.weekYear}-W${String(start.weekNumber).padStart(2, "0")}`);
  });
  r.get("/babies/:babyId/summaries/monthly", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const month = ctx.query.get("month") ?? localDateOf(new Date(), a.householdTz).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest("month must look like 2026-10");
    const start = DateTime.fromISO(`${month}-01`);
    if (!start.isValid) throw badRequest("Invalid month");
    return rangeSummary(ctx, a, start.toISODate()!, start.endOf("month").toISODate()!, month);
  });
}
