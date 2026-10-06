import "server-only";
import { z } from "zod";
import { uuidv7 } from "@/lib/ids";
import { localDateOf } from "@/lib/age";
import { ApiError, badRequest, conflict, notFound, requireIfMatch, zDate, type Ctx, type Router } from "../http";
import { audit, requireBaby, softDelete, upsertTimeline, versionedUpdate, type BabyAccess } from "../core";
import { buildPlan, loadScheduleItems, SCHEDULES, type ScheduleId } from "../vaccines";

const SELECT = `SELECT id, baby_id, vaccine_code, vaccine_name_as_recorded, dose_label, to_char(given_on,'YYYY-MM-DD') AS given_on, schedule_id, schedule_version_id, schedule_item_id,
  clinic_id, given_by, lot_number, card_document_id, appointment_id, notes, version, created_at FROM vaccination`;

async function selection(ctx: Ctx, babyId: string) {
  return ctx.q.one<{ schedule_id: ScheduleId; je_opt_in: boolean }>("SELECT schedule_id, je_opt_in FROM baby_schedule_selection WHERE baby_id = $1 AND ended_at IS NULL", [babyId]);
}

export async function vaccinePlan(ctx: Ctx, a: BabyAccess) {
  const sel = (await selection(ctx, a.babyId)) ?? { schedule_id: "GOVERNMENT_OF_INDIA_UIP" as ScheduleId, je_opt_in: false };
  const items = await loadScheduleItems(ctx.q, sel.schedule_id);
  const given = await ctx.q<{ id: string; vaccine_code: string | null; given_on: string }>(`SELECT id, vaccine_code, to_char(given_on,'YYYY-MM-DD') AS given_on FROM vaccination WHERE baby_id = $1 AND deleted_at IS NULL`, [a.babyId]);
  const plan = buildPlan({ scheduleId: sel.schedule_id, birthDate: a.baby.birth_date, today: localDateOf(new Date(), a.householdTz), jeOptIn: sel.je_opt_in, given, items });
  return { schedule_id: sel.schedule_id, je_opt_in: sel.je_opt_in, ...plan };
}

export async function nextVaccine(ctx: Ctx, a: BabyAccess) {
  const p = await vaccinePlan(ctx, a);
  return p.items.find((i) => i.status === "DUE" || i.status === "PAST_STATED_AGE_LIMIT") ?? p.items.find((i) => i.status === "UPCOMING") ?? null;
}

const fields = {
  vaccine_code: z.string().max(40).nullish(),
  vaccine_name_as_recorded: z.string().trim().min(1).max(120),
  dose_label: z.string().trim().max(60).nullish(),
  given_on: zDate,
  clinic_id: z.string().uuid().nullish(),
  given_by: z.string().trim().max(120).nullish(),
  lot_number: z.string().trim().max(60).nullish(),
  card_document_id: z.string().uuid().nullish(),
  appointment_id: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
};

export function registerVaccinations(r: Router) {
  r.get("/vaccine-schedules", async (ctx) => {
    const meta = await ctx.q.one<{ value: unknown }>("SELECT value FROM reference_meta WHERE key = 'vaccination_schedules'");
    const gates = await ctx.q<{ bucket: string; n: number; cleared: number }>(`SELECT bucket, count(*)::int AS n, count(*) FILTER (WHERE release_gate = 'CLEARED')::int AS cleared FROM reference_rule WHERE bucket LIKE 'vaccination:%' GROUP BY bucket`);
    return { schedules: meta?.value ?? [], release: gates };
  });

  r.get("/babies/:babyId/schedule-selection", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return (await selection(ctx, a.babyId)) ?? { schedule_id: "GOVERNMENT_OF_INDIA_UIP", je_opt_in: false };
  });
  r.put("/babies/:babyId/schedule-selection", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ schedule_id: z.enum(["GOVERNMENT_OF_INDIA_UIP", "IAP_RECOMMENDED_SCHEDULE"]), je_opt_in: z.boolean().default(false) }));
    await ctx.q("UPDATE baby_schedule_selection SET ended_at = now() WHERE baby_id = $1 AND ended_at IS NULL", [a.babyId]);
    await ctx.q("INSERT INTO baby_schedule_selection(id, baby_id, schedule_id, je_opt_in, selected_by) VALUES ($1,$2,$3,$4,$5)", [uuidv7(), a.babyId, b.schedule_id, b.je_opt_in, ctx.session!.userId]);
    await audit(ctx, "SCHEDULE_SELECTED", { babyId: a.babyId, table: "baby_schedule_selection", detail: b });
    return b;
  });

  r.get("/babies/:babyId/vaccinations/plan", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const p = await vaccinePlan(ctx, a);
    if (!p.items.length) throw new ApiError(409, "SCHEDULE_NOT_RELEASED", "This schedule isn't available yet", "The schedule is pending clinical verification. You can still record vaccines given.");
    return p;
  });

  r.get("/babies/:babyId/vaccinations", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return { data: await ctx.q(`${SELECT} WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY given_on DESC`, [a.babyId]), next_cursor: null };
  });

  r.post("/babies/:babyId/vaccinations", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ ...fields, force: z.boolean().optional() }));
    const today = localDateOf(new Date(), a.householdTz);
    if (b.given_on > today) throw badRequest("Date given can't be in the future");
    if (b.given_on < a.baby.birth_date) throw badRequest("Date given is before the date of birth");
    const sel = (await selection(ctx, a.babyId)) ?? { schedule_id: "GOVERNMENT_OF_INDIA_UIP" as ScheduleId };
    let itemId: string | null = null;
    if (b.vaccine_code) {
      const def = Object.values(SCHEDULES).flat().find((d) => d.code === b.vaccine_code);
      if (!def) throw badRequest("Unknown vaccine code");
      itemId = def.itemId;
      if (!b.force) {
        const dup = await ctx.q.one(`${SELECT} WHERE baby_id = $1 AND vaccine_code = $2 AND deleted_at IS NULL`, [a.babyId, b.vaccine_code]);
        if (dup) throw conflict("DUPLICATE_SUSPECTED", "This dose is already recorded. Save another record anyway?", { duplicate_of: dup });
      }
    }
    const id = uuidv7();
    await ctx.q(`INSERT INTO vaccination(id, baby_id, vaccine_code, vaccine_name_as_recorded, dose_label, given_on, schedule_id, schedule_version_id, schedule_item_id, clinic_id, given_by, lot_number, card_document_id, appointment_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [id, a.babyId, b.vaccine_code ?? null, b.vaccine_name_as_recorded, b.dose_label ?? null, b.given_on, sel.schedule_id,
       sel.schedule_id === "GOVERNMENT_OF_INDIA_UIP" ? "GOI_UIP_2023_FIPV3_AMENDMENT" : "IAP_ACVIP_2023", itemId, b.clinic_id ?? null, b.given_by ?? null,
       b.lot_number ?? null, b.card_document_id ?? null, b.appointment_id ?? null, b.notes ?? null, ctx.session!.userId]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "VACCINE", occurredAt: `${b.given_on}T12:00:00Z`, tz: a.householdTz, table: "vaccination", id, title: `Vaccine given · ${b.vaccine_name_as_recorded}${b.dose_label ? ` (${b.dose_label})` : ""}`, importance: 1 });
    await audit(ctx, "VACCINATION_CREATE", { babyId: a.babyId, table: "vaccination", id });
    return ctx.q.one(`${SELECT} WHERE id = $1`, [id]);
  });

  r.patch("/babies/:babyId/vaccinations/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(fields).partial());
    if (b.given_on && (b.given_on > localDateOf(new Date(), a.householdTz) || b.given_on < a.baby.birth_date)) throw badRequest("Date given is out of range");
    const row = await versionedUpdate<{ given_on: string; vaccine_name_as_recorded: string; dose_label: string | null }>(ctx.q, "vaccination", ctx.params.id, a.babyId, v,
      Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    const out = await ctx.q.one<{ given_on: string; vaccine_name_as_recorded: string; dose_label: string | null }>(`${SELECT} WHERE id = $1`, [ctx.params.id]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "VACCINE", occurredAt: `${out!.given_on}T12:00:00Z`, tz: a.householdTz, table: "vaccination", id: ctx.params.id, title: `Vaccine given · ${out!.vaccine_name_as_recorded}${out!.dose_label ? ` (${out!.dose_label})` : ""}`, importance: 1 });
    await audit(ctx, "VACCINATION_UPDATE", { babyId: a.babyId, table: "vaccination", id: ctx.params.id });
    void row;
    return out;
  });

  r.delete("/babies/:babyId/vaccinations/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "vaccination", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "VACCINATION_DELETE", { babyId: a.babyId, table: "vaccination", id: ctx.params.id });
    return null;
  });

  void notFound;
}
