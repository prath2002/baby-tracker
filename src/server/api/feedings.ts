import "server-only";
import { z } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { calculateBabyAge, localDateOf } from "@/lib/age";
import { calculateDailyMeasuredMilk, calculateFeedingFrequency, mlToOz, ozToMl, type FeedLike } from "@/lib/milk";
import { ApiError, badRequest, conflict, notFound, pageParams, requireIfMatch, ruleViolation, zDate, zDateTime, type Ctx, type Router } from "../http";
import { audit, checkEventTime, cursorClause, nextCursor, requireBaby, softDelete, upsertTimeline, versionedUpdate, type BabyAccess } from "../core";
import { loadRules, resolveReference, type BabyFacts, type FeedingPlanRow } from "../reference/engine";

const TYPES = ["DIRECT_BREASTFEEDING", "EXPRESSED_BREASTMILK", "FORMULA", "OTHER"] as const;
const QUANTITY_CONFIRM_ML = 500; // data-entry guard only (not a medical value)

const feedingFields = {
  occurred_at: zDateTime,
  occurred_tz: z.string().max(64).optional(),
  feeding_type: z.enum(TYPES),
  feeding_method: z.enum(["BREAST", "BOTTLE", "CUP", "PALADAI", "SPOON", "TUBE", "OTHER"]).nullish(),
  quantity_ml: z.number().positive().max(2000).nullish(),
  quantity_oz: z.number().positive().max(70).nullish(),
  quantity_offered_ml: z.number().positive().max(2000).nullish(),
  duration_minutes: z.number().int().min(0).max(240).nullish(),
  breast_side: z.enum(["LEFT", "RIGHT", "BOTH"]).nullish(),
  other_description: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(2000).nullish(),
};
const createSchema = z.object({ ...feedingFields, client_id: z.string().max(64).optional(), force: z.boolean().optional(), confirm_quantity: z.boolean().optional() });
const patchSchema = z.object(feedingFields).partial().extend({ force: z.boolean().optional(), confirm_quantity: z.boolean().optional() });

type FeedRow = { id: string; baby_id: string; occurred_at: Date; feeding_type: string; quantity_ml: string | null; local_date: string; version: number } & Record<string, unknown>;

function normaliseQuantity(b: { feeding_type?: string; quantity_ml?: number | null; quantity_oz?: number | null }) {
  if (b.quantity_ml != null && b.quantity_oz != null) throw badRequest("Send quantity_ml or quantity_oz, not both");
  if (b.quantity_oz != null) return { quantity_ml: ozToMl(b.quantity_oz), quantity_oz: b.quantity_oz, entered_unit: "OZ" as const };
  if (b.quantity_ml != null) return { quantity_ml: Math.round(b.quantity_ml * 10) / 10, quantity_oz: mlToOz(b.quantity_ml), entered_unit: "ML" as const };
  return { quantity_ml: null, quantity_oz: null, entered_unit: null };
}

function validateRules(f: { feeding_type: string; quantity_ml: number | null; breast_side?: string | null; quantity_offered_ml?: number | null; other_description?: string | null }, confirm?: boolean) {
  if (f.feeding_type === "DIRECT_BREASTFEEDING" && (f.quantity_ml != null || f.quantity_offered_ml != null))
    throw ruleViolation("BREASTFEEDING_VOLUME_NOT_ALLOWED", "Direct breastfeeding is recorded without a volume. Volume cannot be reliably inferred from duration.");
  if ((f.feeding_type === "EXPRESSED_BREASTMILK" || f.feeding_type === "FORMULA") && f.quantity_ml == null)
    throw badRequest("Quantity is required for expressed milk and formula", [{ field: "quantity_ml", code: "required", message: "Enter the amount" }]);
  if (f.breast_side && f.feeding_type !== "DIRECT_BREASTFEEDING") throw badRequest("Breast side applies only to direct breastfeeding");
  if (f.quantity_ml != null && f.quantity_ml > QUANTITY_CONFIRM_ML && !confirm)
    throw new ApiError(422, "CONFIRMATION_REQUIRED", "Please confirm this amount", `${f.quantity_ml} ml in one feed is unusually large for data entry. Check the unit and confirm.`);
}

export function feedTitle(f: { feeding_type: string; quantity_ml: number | string | null; breast_side?: string | null; duration_minutes?: number | null; other_description?: string | null }) {
  switch (f.feeding_type) {
    case "DIRECT_BREASTFEEDING": return `Breastfeed${f.breast_side ? ` · ${String(f.breast_side).toLowerCase()}` : ""}${f.duration_minutes ? ` · ${f.duration_minutes} min` : ""}`;
    case "EXPRESSED_BREASTMILK": return `Expressed breast milk · ${Number(f.quantity_ml)} ml`;
    case "FORMULA": return `Formula · ${Number(f.quantity_ml)} ml`;
    default: return `Other feed${f.other_description ? ` · ${f.other_description}` : ""}`;
  }
}

function dto(r: FeedRow) {
  return { ...r, quantity_ml: r.quantity_ml != null ? Number(r.quantity_ml) : null, quantity_oz: r.quantity_oz != null ? Number(r.quantity_oz) : null, quantity_offered_ml: r.quantity_offered_ml != null ? Number(r.quantity_offered_ml) : null };
}
const SELECT = `SELECT id, baby_id, occurred_at, occurred_tz, to_char(local_date,'YYYY-MM-DD') AS local_date, feeding_type, feeding_method, quantity_ml, quantity_oz, entered_unit,
  quantity_offered_ml, duration_minutes, breast_side, other_description, notes, client_id, moved_from_baby_id, created_at, created_by, updated_at, version FROM feeding`;

export async function babyFacts(ctx: Ctx, a: BabyAccess, now = new Date()): Promise<BabyFacts> {
  const p = await ctx.q.one<{ birth_weight_kg: string | null; ga_weeks: number | null; ga_unknown: boolean; unable_to_breastfeed: boolean | null; show_clinical_references: boolean }>(
    "SELECT birth_weight_kg, ga_weeks, ga_unknown, unable_to_breastfeed, show_clinical_references FROM baby_profile WHERE baby_id = $1", [a.babyId]);
  const w = await ctx.q.one<{ weight_kg: string }>("SELECT weight_kg FROM weight_measurement WHERE baby_id = $1 AND weight_kg IS NOT NULL AND deleted_at IS NULL ORDER BY measured_at DESC LIMIT 1", [a.babyId]);
  const age = calculateBabyAge({ birthDate: a.baby.birth_date, birthTime: a.baby.birth_time, birthTz: a.baby.birth_tz }, now, a.householdTz);
  return {
    ageDays: age.totalDays, dayOfLife: age.dayOfLife!, birthWeightKg: p?.birth_weight_kg != null ? Number(p.birth_weight_kg) : null,
    latestWeightKg: w ? Number(w.weight_kg) : null, gaWeeks: p?.ga_weeks ?? null, gaUnknown: p?.ga_unknown ?? false,
    unableToBreastfeed: p?.unable_to_breastfeed ?? null, showClinicalReferences: p?.show_clinical_references ?? false,
  };
}

export async function activePlan(ctx: Ctx, babyId: string, date: string): Promise<FeedingPlanRow | null> {
  return ctx.q.one<FeedingPlanRow>(
    `SELECT id, clinician_name, to_char(instructed_on,'YYYY-MM-DD') AS instructed_on, plan_text, volume_ml_per_feed, feeds_per_day, entered_from
     FROM feeding_plan WHERE baby_id = $1 AND deleted_at IS NULL AND valid_from <= $2 AND (valid_to IS NULL OR valid_to >= $2) ORDER BY valid_from DESC LIMIT 1`, [babyId, date]);
}

export async function applicableReference(ctx: Ctx, a: BabyAccess, method = "ANY", date?: string) {
  const facts = await babyFacts(ctx, a);
  const plan = await activePlan(ctx, a.babyId, date ?? localDateOf(new Date(), a.householdTz));
  const rules = await loadRules(ctx.q);
  return resolveReference(rules, facts, method, plan, "PARENT");
}

export async function feedsInRange(ctx: Ctx, babyId: string, from: string, to: string): Promise<FeedLike[]> {
  return ctx.q<FeedLike>(`SELECT feeding_type, quantity_ml, to_char(local_date,'YYYY-MM-DD') AS local_date, occurred_at FROM feeding
    WHERE baby_id = $1 AND deleted_at IS NULL AND local_date BETWEEN $2 AND $3 ORDER BY occurred_at`, [babyId, from, to]);
}

export async function dailyFeedingSummary(ctx: Ctx, a: BabyAccess, date: string) {
  const feeds = await feedsInRange(ctx, a.babyId, date, date);
  const day = calculateDailyMeasuredMilk(feeds, date);
  const plan = await activePlan(ctx, a.babyId, date);
  const freq = calculateFeedingFrequency(feeds);
  const reference = await applicableReference(ctx, a, day.directBreastfeedingSessions && !day.measuredFeedCount ? "DIRECT_BREASTFEEDING" : "ANY", date);
  let plan_comparison: string | null = null;
  if (plan) {
    const planned = plan.volume_ml_per_feed && plan.feeds_per_day ? `${plan.feeds_per_day} × ${Number(plan.volume_ml_per_feed)} ml` : "see plan text";
    plan_comparison = `Recorded measurable milk: ${day.measuredMl ?? "not available"}${day.measuredMl != null ? " ml" : ""}; care-team plan: ${planned}.`;
  }
  return { ...day, median_interval_min: freq.medianIntervalMin, reference, plan_comparison };
}

export function registerFeedings(r: Router) {
  r.get("/babies/:babyId/feedings", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const { limit, cursor } = pageParams(ctx.query);
    const params: unknown[] = [a.babyId];
    let where = "WHERE baby_id = $1 AND deleted_at IS NULL";
    const type = ctx.query.get("type");
    if (type) { if (!TYPES.includes(type as never)) throw badRequest("Unknown type"); params.push(type); where += ` AND feeding_type = $${params.length}`; }
    const from = ctx.query.get("from"), to = ctx.query.get("to");
    if (from) { params.push(from); where += ` AND occurred_at >= $${params.length}`; }
    if (to) { params.push(to); where += ` AND occurred_at <= $${params.length}`; }
    const asc = ctx.query.get("sort") === "occurred_at";
    const cc = cursorClause(cursor, "occurred_at", params.length + 1, !asc);
    params.push(...cc.value);
    params.push(limit);
    const rows = await ctx.q<FeedRow>(`${SELECT} ${where}${cc.sql} ORDER BY occurred_at ${asc ? "ASC" : "DESC"}, id ${asc ? "ASC" : "DESC"} LIMIT $${params.length}`, params);
    return { data: rows.map(dto), next_cursor: nextCursor(rows, limit, "occurred_at") };
  });

  r.post("/babies/:babyId/feedings", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(createSchema);
    checkEventTime(a, b.occurred_at, "Feed");
    const qty = normaliseQuantity(b);
    validateRules({ ...b, quantity_ml: qty.quantity_ml }, b.confirm_quantity || b.force);
    if (b.client_id) {
      const existing = await ctx.q.one<FeedRow>(`${SELECT} WHERE baby_id = $1 AND client_id = $2`, [a.babyId, b.client_id]);
      if (existing) return dto(existing); // offline replay
    }
    if (!b.force) {
      const dup = await ctx.q.one<FeedRow>(`${SELECT} WHERE baby_id = $1 AND feeding_type = $2 AND deleted_at IS NULL
        AND abs(extract(epoch FROM (occurred_at - $3::timestamptz))) <= 120 AND quantity_ml IS NOT DISTINCT FROM $4::numeric`, [a.babyId, b.feeding_type, b.occurred_at, qty.quantity_ml]);
      if (dup) throw conflict("DUPLICATE_SUSPECTED", "This looks like a duplicate of a feed recorded at almost the same time. Save anyway?", { duplicate_of: dto(dup) });
    }
    const id = uuidv7();
    const tz = b.occurred_tz || a.householdTz;
    const localDate = localDateOf(new Date(b.occurred_at), a.householdTz);
    await ctx.q(`INSERT INTO feeding(id, baby_id, occurred_at, occurred_tz, local_date, feeding_type, feeding_method, quantity_ml, quantity_oz, entered_unit, quantity_offered_ml,
        duration_minutes, breast_side, other_description, notes, client_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [id, a.babyId, b.occurred_at, tz, localDate, b.feeding_type, b.feeding_method ?? (b.feeding_type === "DIRECT_BREASTFEEDING" ? "BREAST" : null), qty.quantity_ml, qty.quantity_oz, qty.entered_unit,
       b.quantity_offered_ml ?? null, b.duration_minutes ?? null, b.breast_side ?? null, b.other_description ?? null, b.notes ?? null, b.client_id ?? null, ctx.session!.userId]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "FEEDING", occurredAt: b.occurred_at, tz, table: "feeding", id, title: feedTitle({ ...b, quantity_ml: qty.quantity_ml }) });
    await audit(ctx, "FEEDING_CREATE", { babyId: a.babyId, table: "feeding", id });
    return dto((await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1`, [id]))!);
  });

  r.get("/babies/:babyId/feedings/summary", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const date = ctx.query.get("date") ?? localDateOf(new Date(), a.householdTz);
    zDate.parse(date);
    return dailyFeedingSummary(ctx, a, date);
  });

  r.get("/babies/:babyId/feedings/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const row = await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!row) throw notFound("Feed");
    return dto(row);
  });

  r.patch("/babies/:babyId/feedings/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(patchSchema);
    const cur = await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!cur) throw notFound("Feed");
    const type = b.feeding_type ?? cur.feeding_type;
    const qtyGiven = b.quantity_ml !== undefined || b.quantity_oz !== undefined;
    const qty = qtyGiven ? normaliseQuantity(b) : type === "DIRECT_BREASTFEEDING" ? { quantity_ml: null, quantity_oz: null, entered_unit: null } : { quantity_ml: cur.quantity_ml != null ? Number(cur.quantity_ml) : null, quantity_oz: cur.quantity_oz as number | null, entered_unit: cur.entered_unit as "ML" | null };
    const merged = { ...dto(cur), ...b, ...qty, feeding_type: type } as Record<string, unknown> & { feeding_type: string; quantity_ml: number | null; breast_side?: string | null };
    if (type !== "DIRECT_BREASTFEEDING" && b.breast_side === undefined) merged.breast_side = null;
    if (type === "DIRECT_BREASTFEEDING") merged.quantity_offered_ml = null;
    validateRules(merged as never, b.confirm_quantity || b.force);
    if (b.occurred_at) checkEventTime(a, b.occurred_at, "Feed");
    const sets: Record<string, unknown> = {
      occurred_at: merged.occurred_at, occurred_tz: merged.occurred_tz, local_date: localDateOf(new Date(merged.occurred_at as string), a.householdTz),
      feeding_type: type, feeding_method: merged.feeding_method ?? null, quantity_ml: qty.quantity_ml, quantity_oz: qty.quantity_oz, entered_unit: qty.entered_unit,
      quantity_offered_ml: merged.quantity_offered_ml ?? null, duration_minutes: merged.duration_minutes ?? null, breast_side: merged.breast_side ?? null,
      other_description: merged.other_description ?? null, notes: merged.notes ?? null,
    };
    const row = await versionedUpdate<FeedRow>(ctx.q, "feeding", cur.id, a.babyId, v, sets, ctx.session!.userId);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "FEEDING", occurredAt: row.occurred_at, tz: String(sets.occurred_tz), table: "feeding", id: cur.id, title: feedTitle(sets as never) });
    await audit(ctx, "FEEDING_UPDATE", { babyId: a.babyId, table: "feeding", id: cur.id, detail: { before: { quantity_ml: cur.quantity_ml, feeding_type: cur.feeding_type, occurred_at: cur.occurred_at }, after: { quantity_ml: qty.quantity_ml, feeding_type: type, occurred_at: sets.occurred_at } } });
    return dto((await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1`, [cur.id]))!);
  });

  r.delete("/babies/:babyId/feedings/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    await softDelete(ctx.q, "feeding", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "FEEDING_DELETE", { babyId: a.babyId, table: "feeding", id: ctx.params.id });
    return null;
  });

  r.post("/babies/:babyId/feedings/:id/restore", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const rows = await ctx.q<FeedRow>("UPDATE feeding SET deleted_at = NULL, deleted_by = NULL, version = version + 1 WHERE id = $1 AND baby_id = $2 AND deleted_at > now() - interval '1 day' RETURNING id", [ctx.params.id, a.babyId]);
    if (!rows.length) throw notFound("Feed");
    await ctx.q("UPDATE timeline_event SET is_hidden = false WHERE source_table = 'feeding' AND source_id = $1", [ctx.params.id]);
    await audit(ctx, "FEEDING_RESTORE", { babyId: a.babyId, table: "feeding", id: ctx.params.id });
    return dto((await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1`, [ctx.params.id]))!);
  });

  r.post("/babies/:babyId/feedings/:id/move", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(z.object({ target_baby_id: z.string().uuid() }));
    if (b.target_baby_id === a.babyId) throw badRequest("Target is the same baby");
    const t = await requireBaby(ctx, b.target_baby_id, "LOG");
    const v = requireIfMatch(ctx);
    const cur = await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!cur) throw notFound("Feed");
    if (cur.version !== v) throw new ApiError(412, "VERSION_MISMATCH", "This record was changed by someone else");
    const tBirth = DateTime.fromISO(t.baby.birth_date, { zone: t.baby.birth_tz }).startOf("day").toMillis();
    if (cur.occurred_at.getTime() < tBirth) throw badRequest("This feed is before the other baby's date of birth");
    await ctx.q(`UPDATE feeding SET baby_id = $3, moved_from_baby_id = $2, local_date = (occurred_at AT TIME ZONE $4)::date, client_id = NULL, version = version + 1, updated_at = now(), updated_by = $5 WHERE id = $1 AND baby_id = $2`,
      [cur.id, a.babyId, t.babyId, t.householdTz, ctx.session!.userId]);
    await ctx.q("UPDATE timeline_event SET baby_id = $2 WHERE source_table = 'feeding' AND source_id = $1", [cur.id, t.babyId]);
    await audit(ctx, "FEEDING_MOVED", { babyId: a.babyId, table: "feeding", id: cur.id, detail: { from: a.babyId, to: t.babyId } });
    await audit(ctx, "FEEDING_MOVED_IN", { babyId: t.babyId, table: "feeding", id: cur.id, detail: { from: a.babyId, to: t.babyId } });
    return dto((await ctx.q.one<FeedRow>(`${SELECT} WHERE id = $1`, [cur.id]))!);
  });

  // ---------- care-team feeding plans ----------
  const planSchema = z.object({
    entered_from: z.enum(["PRESCRIPTION", "DISCHARGE_SUMMARY", "VERBAL_INSTRUCTION", "OTHER"]),
    clinician_name: z.string().trim().min(1).max(120), instructed_on: zDate, plan_text: z.string().trim().min(1).max(2000),
    volume_ml_per_feed: z.number().positive().max(1000).nullish(), feeds_per_day: z.number().int().min(1).max(24).nullish(),
    valid_from: zDate, valid_to: zDate.nullish(), attachment_document_id: z.string().uuid().nullish(),
  });
  r.get("/babies/:babyId/feeding-plans", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return { data: await ctx.q(`SELECT id, entered_from, clinician_name, to_char(instructed_on,'YYYY-MM-DD') AS instructed_on, plan_text, volume_ml_per_feed::float, feeds_per_day,
       to_char(valid_from,'YYYY-MM-DD') AS valid_from, to_char(valid_to,'YYYY-MM-DD') AS valid_to, attachment_document_id, version, created_at FROM feeding_plan WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY valid_from DESC`, [a.babyId]), next_cursor: null };
  });
  r.post("/babies/:babyId/feeding-plans", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(planSchema);
    if (b.valid_to && b.valid_to < b.valid_from) throw badRequest("valid_to must be on or after valid_from");
    const id = uuidv7();
    await ctx.q(`INSERT INTO feeding_plan(id, baby_id, entered_from, clinician_name, instructed_on, plan_text, volume_ml_per_feed, feeds_per_day, valid_from, valid_to, attachment_document_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [id, a.babyId, b.entered_from, b.clinician_name, b.instructed_on, b.plan_text, b.volume_ml_per_feed ?? null, b.feeds_per_day ?? null, b.valid_from, b.valid_to ?? null, b.attachment_document_id ?? null, ctx.session!.userId]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "IMPORTANT_MEDICAL_EVENT", occurredAt: `${b.instructed_on}T12:00:00Z`, tz: a.householdTz, table: "feeding_plan", id, title: `Care-team feeding plan recorded (${b.clinician_name})`, summary: b.plan_text.slice(0, 140), importance: 1 });
    await audit(ctx, "FEEDING_PLAN_CREATE", { babyId: a.babyId, table: "feeding_plan", id });
    return { id };
  });
  r.patch("/babies/:babyId/feeding-plans/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(planSchema.partial());
    const row = await versionedUpdate(ctx.q, "feeding_plan", ctx.params.id, a.babyId, v, Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    await audit(ctx, "FEEDING_PLAN_UPDATE", { babyId: a.babyId, table: "feeding_plan", id: ctx.params.id });
    return row;
  });
  r.delete("/babies/:babyId/feeding-plans/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "feeding_plan", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "FEEDING_PLAN_DELETE", { babyId: a.babyId, table: "feeding_plan", id: ctx.params.id });
    return null;
  });
}
