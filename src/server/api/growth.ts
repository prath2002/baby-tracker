import "server-only";
import { z } from "zod";
import { uuidv7 } from "@/lib/ids";
import { calculateBabyAge, localDateOf, parseCalendarDate } from "@/lib/age";
import { adjustLengthForPosition, interpolateLms, percentileFromZ, valueAtZ, zScore, type Indicator } from "@/lib/growth";
import { ApiError, badRequest, conflict, notFound, pageParams, requireIfMatch, zDateTime, type Router } from "../http";
import { audit, cursorClause, nextCursor, requireBaby, softDelete, upsertTimeline, versionedUpdate } from "../core";
import { isDisplayable, isPreviewOnly } from "../reference/engine";
import { referencePreview } from "../env";

const fields = {
  measured_at: zDateTime,
  measured_tz: z.string().max(64).optional(),
  weight_kg: z.number().positive().lt(60).nullish(),
  length_cm: z.number().positive().lt(200).nullish(),
  length_position: z.enum(["RECUMBENT", "STANDING"]).nullish(),
  head_circumference_cm: z.number().positive().lt(80).nullish(),
  measurement_source: z.enum(["HOME_SCALE", "CLINIC", "HOSPITAL", "ANGANWADI", "OTHER"]),
  notes: z.string().trim().max(2000).nullish(),
};
const GUARDS = { weight_kg: [0.3, 30], length_cm: [30, 125], head_circumference_cm: [20, 60] } as const; // data-entry guards only

const SELECT = `SELECT id, baby_id, measured_at, measured_tz, to_char(local_date,'YYYY-MM-DD') AS local_date, weight_kg::float, length_cm::float, length_position,
  head_circumference_cm::float, measurement_source, notes, version, created_at FROM weight_measurement`;

type MRow = { id: string; measured_at: Date; local_date: string; weight_kg: number | null; length_cm: number | null; length_position: "RECUMBENT" | "STANDING" | null; head_circumference_cm: number | null; version: number; measurement_source: string };

function guardCheck(b: Record<string, unknown>, confirm?: boolean) {
  for (const [k, [lo, hi]] of Object.entries(GUARDS)) {
    const v = b[k] as number | null | undefined;
    if (v != null && (v < lo || v > hi) && !confirm) throw new ApiError(422, "CONFIRMATION_REQUIRED", "Please confirm this measurement", `${k.replace(/_/g, " ")} ${v} looks unusual. Check the unit and confirm.`);
  }
}

function withChanges(rows: MRow[]) {
  // rows newest first; change vs previous weight measurement
  const asc = [...rows].reverse();
  let prev: MRow | null = null;
  const out = new Map<string, { change_since_previous_g: number | null; days_since_previous: number | null; g_per_day: number | null }>();
  for (const r of asc) {
    if (r.weight_kg != null && prev?.weight_kg != null) {
      const d = Math.round((Date.parse(r.local_date) - Date.parse(prev.local_date)) / 86_400_000);
      const g = Math.round((r.weight_kg - prev.weight_kg) * 1000);
      out.set(r.id, { change_since_previous_g: g, days_since_previous: d, g_per_day: d >= 1 ? Math.round((g / d) * 10) / 10 : null });
    } else out.set(r.id, { change_since_previous_g: null, days_since_previous: null, g_per_day: null });
    if (r.weight_kg != null) prev = r;
  }
  return rows.map((r) => ({ ...r, ...out.get(r.id) }));
}

const IND: Record<string, { code: Indicator; prefix: string; axis: "AGE_DAYS" | "LENGTH" }> = {
  WEIGHT_FOR_AGE: { code: "WFA", prefix: "WFA", axis: "AGE_DAYS" },
  LENGTH_HEIGHT_FOR_AGE: { code: "LHFA", prefix: "LHFA", axis: "AGE_DAYS" },
  HEAD_CIRCUMFERENCE_FOR_AGE: { code: "HCFA", prefix: "HCFA", axis: "AGE_DAYS" },
  BMI_FOR_AGE: { code: "BMI", prefix: "BFA", axis: "AGE_DAYS" },
  WEIGHT_FOR_LENGTH: { code: "WFL", prefix: "WFL", axis: "LENGTH" },
  WEIGHT_FOR_HEIGHT: { code: "WFH", prefix: "WFH", axis: "LENGTH" },
};

export function registerGrowth(r: Router) {
  r.get("/babies/:babyId/measurements", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const { limit, cursor } = pageParams(ctx.query);
    const cc = cursorClause(cursor, "measured_at", 2);
    const rows = await ctx.q<MRow>(`${SELECT} WHERE baby_id = $1 AND deleted_at IS NULL${cc.sql} ORDER BY measured_at DESC, id DESC LIMIT $${2 + cc.value.length}`, [a.babyId, ...cc.value, limit]);
    return { data: withChanges(rows), next_cursor: nextCursor(rows, limit, "measured_at") };
  });

  r.post("/babies/:babyId/measurements", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(z.object({ ...fields, client_id: z.string().max(64).optional(), confirm: z.boolean().optional(), force: z.boolean().optional() }));
    if (b.weight_kg == null && b.length_cm == null && b.head_circumference_cm == null) throw badRequest("Enter at least one of weight, length or head circumference");
    if (new Date(b.measured_at).getTime() > Date.now() + 5 * 60_000) throw badRequest("Measurement time can't be in the future");
    const localDate = localDateOf(new Date(b.measured_at), a.householdTz);
    if (localDate < a.baby.birth_date) throw badRequest("Measurement date is before the date of birth");
    guardCheck(b, b.confirm || b.force);
    if (b.client_id) {
      const ex = await ctx.q.one<MRow>(`${SELECT} WHERE baby_id = $1 AND client_id = $2`, [a.babyId, b.client_id]);
      if (ex) return ex;
    }
    if (!b.force) {
      const same = await ctx.q.one<MRow>(`${SELECT} WHERE baby_id = $1 AND local_date = $2 AND deleted_at IS NULL LIMIT 1`, [a.babyId, localDate]);
      if (same) throw conflict("DUPLICATE_SUSPECTED", "A measurement already exists for this day. Save another anyway?", { duplicate_of: same });
    }
    const id = uuidv7();
    const tz = b.measured_tz || a.householdTz;
    await ctx.q(`INSERT INTO weight_measurement(id, baby_id, measured_at, measured_tz, local_date, weight_kg, length_cm, length_position, head_circumference_cm, measurement_source, notes, client_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, a.babyId, b.measured_at, tz, localDate, b.weight_kg ?? null, b.length_cm ?? null, b.length_position ?? null, b.head_circumference_cm ?? null, b.measurement_source, b.notes ?? null, b.client_id ?? null, ctx.session!.userId]);
    const parts = [b.weight_kg != null && `${b.weight_kg} kg`, b.length_cm != null && `${b.length_cm} cm length`, b.head_circumference_cm != null && `${b.head_circumference_cm} cm head`].filter(Boolean).join(" · ");
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "WEIGHT", occurredAt: b.measured_at, tz, table: "weight_measurement", id, title: `Measurement · ${parts}`, summary: b.measurement_source === "HOME_SCALE" ? "Home scale" : null });
    await audit(ctx, "MEASUREMENT_CREATE", { babyId: a.babyId, table: "weight_measurement", id });
    return ctx.q.one(`${SELECT} WHERE id = $1`, [id]);
  });

  r.patch("/babies/:babyId/measurements/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(fields).partial().extend({ confirm: z.boolean().optional() }));
    guardCheck(b, b.confirm);
    const { confirm: _c, ...rest } = b; void _c;
    const sets: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, x]) => x !== undefined));
    if (sets.measured_at) sets.local_date = localDateOf(new Date(String(sets.measured_at)), a.householdTz);
    const row = await versionedUpdate<MRow>(ctx.q, "weight_measurement", ctx.params.id, a.babyId, v, sets, ctx.session!.userId);
    if (row.weight_kg == null && row.length_cm == null && row.head_circumference_cm == null) throw badRequest("At least one value is required");
    await audit(ctx, "MEASUREMENT_UPDATE", { babyId: a.babyId, table: "weight_measurement", id: ctx.params.id });
    return ctx.q.one(`${SELECT} WHERE id = $1`, [ctx.params.id]);
  });

  r.delete("/babies/:babyId/measurements/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    await softDelete(ctx.q, "weight_measurement", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "MEASUREMENT_DELETE", { babyId: a.babyId, table: "weight_measurement", id: ctx.params.id });
    return null;
  });

  r.get("/growth/datasets", async (ctx) =>
    ctx.q("SELECT id, indicator, sex, x_axis, source_file_url, file_sha256, imported_at, row_count, validation_report, release_gate FROM growth_reference_dataset ORDER BY id"));

  r.get("/babies/:babyId/growth", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const indicator = ctx.query.get("indicator") ?? "WEIGHT_FOR_AGE";
    const caveats: string[] = [];
    if (indicator.endsWith("VELOCITY")) {
      return { indicator, status: "REFERENCE_PENDING_REVIEW", points: [], bands: [], caveats: ["Growth velocity references are pending pediatric review of interval-matching rules. Weight change per day is shown in the Weight tracker."] };
    }
    const ind = IND[indicator];
    if (!ind) throw badRequest("Unknown indicator");
    if (a.baby.sex === "NOT_STATED") throw new ApiError(422, "GROWTH_REFERENCE_UNAVAILABLE", "Growth reference unavailable", "WHO growth standards are sex-specific. Add the baby's sex in the profile to see growth references.");
    const sex = a.baby.sex;
    const p = await ctx.q.one<{ ga_weeks: number | null }>("SELECT ga_weeks FROM baby_profile WHERE baby_id = $1", [a.babyId]);
    if (p?.ga_weeks != null && p.ga_weeks < 37) caveats.push("WHO Child Growth Standards describe healthy term-born children. Ask your pediatrician how to interpret growth for a baby born early.");
    const age = calculateBabyAge({ birthDate: a.baby.birth_date }, new Date(), a.householdTz);
    if (age.totalDays > 1856) caveats.push("WHO Child Growth Standards cover birth to 5 years; later measurements are not plotted.");

    const datasetIds = ind.axis === "LENGTH" ? [`${ind.prefix}_${sex}`] : [`${ind.prefix}_${sex}_DAY`];
    const ds = await ctx.q.one<{ id: string; release_gate: string; source_file_url: string; file_sha256: string; validation_report: { passed?: boolean } }>(
      "SELECT id, release_gate, source_file_url, file_sha256, validation_report FROM growth_reference_dataset WHERE id = ANY($1)", [datasetIds]);
    if (!ds) return { indicator, status: "DATASET_NOT_IMPORTED", points: [], bands: [], caveats: [...caveats, "Growth reference unavailable: the official WHO dataset has not been imported yet."] };
    if (!isDisplayable(ds.release_gate) || !ds.validation_report?.passed)
      return { indicator, status: "PENDING_CLINICAL_RELEASE", points: [], bands: [], caveats: [...caveats, "Growth reference is pending clinical review and is not shown yet."] };
    const preview = isPreviewOnly(ds.release_gate);

    const ms = await ctx.q<MRow>(`${SELECT} WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY measured_at`, [a.babyId]);
    const points: unknown[] = [];
    const xs: number[] = [];
    for (const m of ms) {
      const ageDays = Math.round(parseCalendarDate(m.local_date).diff(parseCalendarDate(a.baby.birth_date), "days").days);
      if (ageDays < 0 || ageDays > 1856) continue;
      let x: number, y: number | null = null, note: string | null = null;
      if (ind.axis === "AGE_DAYS") {
        x = ageDays;
        if (ind.code === "WFA") y = m.weight_kg;
        else if (ind.code === "HCFA") y = m.head_circumference_cm;
        else if (ind.code === "LHFA" && m.length_cm != null) { const adj = adjustLengthForPosition(m.length_cm, ageDays, m.length_position); y = adj.cm; if (adj.adjusted) note = "Length adjusted ±0.7 cm for measurement position (WHO convention)"; }
        else if (ind.code === "BMI" && m.weight_kg != null && m.length_cm != null) { const L = adjustLengthForPosition(m.length_cm, ageDays, m.length_position).cm / 100; y = Math.round((m.weight_kg / (L * L)) * 100) / 100; }
      } else {
        if (m.weight_kg == null || m.length_cm == null) continue;
        const adj = adjustLengthForPosition(m.length_cm, ageDays, m.length_position);
        if (ind.code === "WFL" && ageDays >= 731) continue;
        if (ind.code === "WFH" && ageDays < 731) continue;
        x = Math.round(adj.cm * 10) / 10; y = m.weight_kg;
      }
      if (y == null) continue;
      const rows = await ctx.q<{ x: number; l: number; m: number; s: number }>(
        "SELECT x_value::float AS x, l::float, m::float, s::float FROM growth_reference WHERE dataset_id = $1 AND x_value BETWEEN $2 - 0.5 AND $2 + 0.5 ORDER BY x_value", [ds.id, x]);
      const lms = ind.axis === "AGE_DAYS" ? rows.find((r0) => r0.x === x) ?? null : interpolateLms(x, rows);
      if (!lms) { points.push({ measurement_id: m.id, local_date: m.local_date, x, value: y, z_score: null, percentile: null, note: "Outside the WHO table range" }); continue; }
      const z = zScore(y, lms, ind.code);
      xs.push(x);
      points.push({ measurement_id: m.id, local_date: m.local_date, x, value: y, z_score: Math.round(z * 100) / 100, percentile: percentileFromZ(z), label: "Growth reference", note, source: m.measurement_source });
    }
    // Bands for the chart: published SD lines between min and max x of interest
    const maxX = ind.axis === "AGE_DAYS" ? Math.min(1856, Math.max(age.totalDays + 60, 120)) : Math.max(...xs, 65) + 5;
    const minX = ind.axis === "AGE_DAYS" ? 0 : Math.max(45, Math.min(...xs, 120) - 5);
    const step = ind.axis === "AGE_DAYS" ? Math.max(1, Math.round((maxX - minX) / 120)) : 0.5;
    const bandRows = await ctx.q<{ x: number; l: number; m: number; s: number }>(
      `SELECT x_value::float AS x, l::float, m::float, s::float FROM growth_reference WHERE dataset_id = $1 AND x_value BETWEEN $2 AND $3 ORDER BY x_value`, [ds.id, minX, maxX]);
    const bands = bandRows.filter((r0, i) => i % Math.max(1, Math.round(step / (ind.axis === "AGE_DAYS" ? 1 : 0.1))) === 0)
      .map((r0) => ({ x: r0.x, p3: valueAtZ(r0, -1.8808), p15: valueAtZ(r0, -1.0364), p50: r0.m, p85: valueAtZ(r0, 1.0364), p97: valueAtZ(r0, 1.8808) }));
    return {
      indicator, status: "OK", preview, preview_mode: referencePreview(), dataset_id: ds.id, x_axis: ind.axis, points, bands, caveats,
      provenance: { organization: "World Health Organization", document_title: "WHO Child Growth Standards", publication_date: "2006", source_url: ds.source_file_url, file_sha256: ds.file_sha256 },
      today_local: localDateOf(new Date(), a.householdTz),
    };
  });

  void notFound;
}
