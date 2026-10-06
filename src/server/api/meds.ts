import "server-only";
import { z } from "zod";
import { uuidv7 } from "@/lib/ids";
import { localDateOf } from "@/lib/age";
import { badRequest, conflict, notFound, requireIfMatch, zDate, zDateTime, type Router } from "../http";
import { audit, requireBaby, softDelete, upsertTimeline, versionedUpdate } from "../core";

/** Prescriptions are stored verbatim as written. Dosage is never inferred, calculated or validated (spec §27–28). */
const itemSchema = z.object({
  medicine_name: z.string().trim().min(1).max(160),
  strength_text: z.string().trim().max(200).nullish(), dosage_text: z.string().trim().max(400).nullish(), frequency_text: z.string().trim().max(200).nullish(),
  duration_text: z.string().trim().max(200).nullish(), route_text: z.string().trim().max(100).nullish(), instructions_text: z.string().trim().max(1000).nullish(),
});
const rxFields = {
  doctor_id: z.string().uuid().nullish(), clinic_id: z.string().uuid().nullish(), appointment_id: z.string().uuid().nullish(),
  prescribed_on: zDate, diagnosis_text_as_written: z.string().trim().max(1000).nullish(), attachment_document_id: z.string().uuid().nullish(),
  notes: z.string().trim().max(2000).nullish(),
};
const medFields = {
  medicine_name: z.string().trim().min(1).max(160),
  dose_amount: z.number().positive().max(100000).nullish(),
  dose_unit: z.enum(["ML", "MG", "DROPS", "TABLET", "SACHET", "PUFF", "OTHER"]).nullish(),
  dose_text_as_prescribed: z.string().trim().max(400).nullish(),
  start_date: zDate, end_date: zDate.nullish(),
  reason_as_given: z.string().trim().max(400).nullish(),
  doctor_id: z.string().uuid().nullish(), prescription_id: z.string().uuid().nullish(),
  status: z.enum(["ACTIVE", "COMPLETED", "STOPPED"]).optional(),
  notes: z.string().trim().max(2000).nullish(),
};
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleSchema = z.object({
  kind: z.enum(["TIMES_OF_DAY", "EVERY_N_HOURS", "AS_NEEDED"]),
  times_of_day: z.array(hhmm).min(1).max(12).optional(),
  every_n_hours: z.number().int().min(1).max(72).optional(),
  anchor_time: hhmm.optional(),
  tz: z.string().max(64).optional(),
  reminders_enabled: z.boolean().default(true),
  allow_quiet_hours: z.boolean().default(false),
}).refine((s) => s.kind !== "TIMES_OF_DAY" || !!s.times_of_day?.length, "times_of_day required").refine((s) => s.kind !== "EVERY_N_HOURS" || !!s.every_n_hours, "every_n_hours required");

const RX_SELECT = `SELECT p.id, p.baby_id, p.doctor_id, d.name AS doctor_name, p.clinic_id, p.appointment_id, to_char(p.prescribed_on,'YYYY-MM-DD') AS prescribed_on,
  p.diagnosis_text_as_written, p.attachment_document_id, p.notes, p.version, p.created_at FROM prescription p LEFT JOIN doctor d ON d.id = p.doctor_id`;
const MED_SELECT = `SELECT m.id, m.baby_id, m.medicine_name, m.dose_amount::float, m.dose_unit, m.dose_text_as_prescribed, to_char(m.start_date,'YYYY-MM-DD') AS start_date,
  to_char(m.end_date,'YYYY-MM-DD') AS end_date, m.reason_as_given, m.doctor_id, m.prescription_id, m.status, m.notes, m.version, m.created_at,
  (SELECT row_to_json(s) FROM (SELECT kind, times_of_day, every_n_hours, anchor_time, tz, reminders_enabled, allow_quiet_hours FROM medicine_schedule WHERE medicine_id = m.id) s) AS schedule
  FROM medicine m`;

export function registerMeds(r: Router) {
  // ---------- prescriptions ----------
  r.get("/babies/:babyId/prescriptions", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const rows = await ctx.q<{ id: string }>(`${RX_SELECT} WHERE p.baby_id = $1 AND p.deleted_at IS NULL ORDER BY p.prescribed_on DESC`, [a.babyId]);
    for (const row of rows) (row as Record<string, unknown>).items = await ctx.q("SELECT * FROM prescription_item WHERE prescription_id = $1 ORDER BY sort_order", [row.id]);
    return { data: rows, next_cursor: null };
  });
  r.post("/babies/:babyId/prescriptions", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ ...rxFields, items: z.array(itemSchema).max(30).default([]) }));
    if (b.prescribed_on > localDateOf(new Date(), a.householdTz)) throw badRequest("Prescription date can't be in the future");
    const id = uuidv7();
    await ctx.q(`INSERT INTO prescription(id, baby_id, doctor_id, clinic_id, appointment_id, prescribed_on, diagnosis_text_as_written, attachment_document_id, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, a.babyId, b.doctor_id ?? null, b.clinic_id ?? null, b.appointment_id ?? null, b.prescribed_on, b.diagnosis_text_as_written ?? null, b.attachment_document_id ?? null, b.notes ?? null, ctx.session!.userId]);
    let i = 0;
    for (const it of b.items) await ctx.q(`INSERT INTO prescription_item(id, prescription_id, baby_id, medicine_name, strength_text, dosage_text, frequency_text, duration_text, route_text, instructions_text, sort_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [uuidv7(), id, a.babyId, it.medicine_name, it.strength_text ?? null, it.dosage_text ?? null, it.frequency_text ?? null, it.duration_text ?? null, it.route_text ?? null, it.instructions_text ?? null, i++]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "PRESCRIPTION", occurredAt: `${b.prescribed_on}T12:00:00Z`, tz: a.householdTz, table: "prescription", id, title: `Prescription recorded${b.items.length ? ` · ${b.items.map((x) => x.medicine_name).join(", ").slice(0, 80)}` : ""}`, importance: 1 });
    await audit(ctx, "PRESCRIPTION_CREATE", { babyId: a.babyId, table: "prescription", id });
    return { id };
  });
  r.get("/babies/:babyId/prescriptions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const p = await ctx.q.one(`${RX_SELECT} WHERE p.id = $1 AND p.baby_id = $2 AND p.deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!p) throw notFound("Prescription");
    return { ...p, items: await ctx.q("SELECT * FROM prescription_item WHERE prescription_id = $1 ORDER BY sort_order", [ctx.params.id]) };
  });
  r.patch("/babies/:babyId/prescriptions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object({ ...rxFields, items: z.array(itemSchema).max(30) }).partial());
    const { items, ...rest } = b;
    await versionedUpdate(ctx.q, "prescription", ctx.params.id, a.babyId, v, Object.fromEntries(Object.entries(rest).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    if (items) {
      await ctx.q("DELETE FROM prescription_item WHERE prescription_id = $1 AND baby_id = $2", [ctx.params.id, a.babyId]);
      let i = 0;
      for (const it of items) await ctx.q(`INSERT INTO prescription_item(id, prescription_id, baby_id, medicine_name, strength_text, dosage_text, frequency_text, duration_text, route_text, instructions_text, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [uuidv7(), ctx.params.id, a.babyId, it.medicine_name, it.strength_text ?? null, it.dosage_text ?? null, it.frequency_text ?? null, it.duration_text ?? null, it.route_text ?? null, it.instructions_text ?? null, i++]);
    }
    await audit(ctx, "PRESCRIPTION_UPDATE", { babyId: a.babyId, table: "prescription", id: ctx.params.id });
    return { id: ctx.params.id };
  });
  r.delete("/babies/:babyId/prescriptions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "prescription", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "PRESCRIPTION_DELETE", { babyId: a.babyId, table: "prescription", id: ctx.params.id });
    return null;
  });

  // ---------- medicines ----------
  r.get("/babies/:babyId/medicines", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const status = ctx.query.get("status");
    return { data: await ctx.q(`${MED_SELECT} WHERE m.baby_id = $1 AND m.deleted_at IS NULL AND ($2::text IS NULL OR m.status = $2) ORDER BY m.status, m.start_date DESC`, [a.babyId, status]), next_cursor: null };
  });
  r.post("/babies/:babyId/medicines", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ ...medFields, schedule: scheduleSchema.optional() }));
    if (b.end_date && b.end_date < b.start_date) throw badRequest("End date must be on or after the start date");
    const id = uuidv7();
    await ctx.q(`INSERT INTO medicine(id, baby_id, medicine_name, dose_amount, dose_unit, dose_text_as_prescribed, start_date, end_date, reason_as_given, doctor_id, prescription_id, status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, a.babyId, b.medicine_name, b.dose_amount ?? null, b.dose_unit ?? null, b.dose_text_as_prescribed ?? null, b.start_date, b.end_date ?? null, b.reason_as_given ?? null, b.doctor_id ?? null, b.prescription_id ?? null, b.status ?? "ACTIVE", b.notes ?? null, ctx.session!.userId]);
    if (b.schedule) await upsertSchedule(ctx.q, id, a.babyId, b.schedule, a.householdTz);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "MEDICINE", occurredAt: `${b.start_date}T12:00:00Z`, tz: a.householdTz, table: "medicine", id, title: `Medicine started · ${b.medicine_name}` });
    await audit(ctx, "MEDICINE_CREATE", { babyId: a.babyId, table: "medicine", id });
    return ctx.q.one(`${MED_SELECT} WHERE m.id = $1`, [id]);
  });
  r.patch("/babies/:babyId/medicines/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(medFields).partial());
    const row = await versionedUpdate<{ start_date: string; end_date: string | null; status: string; medicine_name: string }>(ctx.q, "medicine", ctx.params.id, a.babyId, v, Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    if (row.end_date && row.end_date < row.start_date) throw badRequest("End date must be on or after the start date");
    if (b.status && b.status !== "ACTIVE") await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`med:${ctx.params.id}:%`]);
    await audit(ctx, "MEDICINE_UPDATE", { babyId: a.babyId, table: "medicine", id: ctx.params.id, detail: { fields: Object.keys(b) } });
    return ctx.q.one(`${MED_SELECT} WHERE m.id = $1`, [ctx.params.id]);
  });
  r.delete("/babies/:babyId/medicines/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "medicine", ctx.params.id, a.babyId, ctx.session!.userId);
    await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`med:${ctx.params.id}:%`]);
    await audit(ctx, "MEDICINE_DELETE", { babyId: a.babyId, table: "medicine", id: ctx.params.id });
    return null;
  });
  r.put("/babies/:babyId/medicines/:id/schedule", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const med = await ctx.q.one("SELECT 1 FROM medicine WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL", [ctx.params.id, a.babyId]);
    if (!med) throw notFound("Medicine");
    const b = await ctx.body(scheduleSchema);
    await upsertSchedule(ctx.q, ctx.params.id, a.babyId, b, a.householdTz);
    await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`med:${ctx.params.id}:%`]);
    await audit(ctx, "MEDICINE_SCHEDULE_SET", { babyId: a.babyId, table: "medicine_schedule", id: ctx.params.id });
    return ctx.q.one(`${MED_SELECT} WHERE m.id = $1`, [ctx.params.id]);
  });
  r.get("/babies/:babyId/medicines/:id/doses", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return { data: await ctx.q(`SELECT d.id, d.scheduled_for, d.status, d.given_at, d.recorded_at, d.notes, u.display_name AS given_by_name FROM medicine_dose d LEFT JOIN app_user u ON u.id = d.given_by
      WHERE d.medicine_id = $1 AND d.baby_id = $2 AND d.deleted_at IS NULL ORDER BY coalesce(d.given_at, d.scheduled_for, d.recorded_at) DESC LIMIT 200`, [ctx.params.id, a.babyId]), next_cursor: null };
  });
  r.post("/babies/:babyId/medicines/:id/doses", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(z.object({ status: z.enum(["GIVEN", "SKIPPED"]), scheduled_for: zDateTime.nullish(), given_at: zDateTime.nullish(), notes: z.string().trim().max(500).nullish(), client_id: z.string().max(64).optional() }));
    const med = await ctx.q.one<{ medicine_name: string }>("SELECT medicine_name FROM medicine WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL", [ctx.params.id, a.babyId]);
    if (!med) throw notFound("Medicine");
    if (b.client_id) { const ex = await ctx.q.one("SELECT id FROM medicine_dose WHERE baby_id = $1 AND client_id = $2", [a.babyId, b.client_id]); if (ex) return ex; }
    if (b.scheduled_for) {
      const ex = await ctx.q.one("SELECT id, status FROM medicine_dose WHERE medicine_id = $1 AND scheduled_for = $2 AND deleted_at IS NULL", [ctx.params.id, b.scheduled_for]);
      if (ex) throw conflict("DOSE_ALREADY_RECORDED", "This scheduled dose is already marked", { existing: ex });
    }
    const id = uuidv7();
    const givenAt = b.status === "GIVEN" ? (b.given_at ?? new Date().toISOString()) : null;
    await ctx.q(`INSERT INTO medicine_dose(id, medicine_id, baby_id, scheduled_for, status, given_at, given_by, notes, client_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7)`,
      [id, ctx.params.id, a.babyId, b.scheduled_for ?? null, b.status, givenAt, ctx.session!.userId, b.notes ?? null, b.client_id ?? null]);
    if (b.scheduled_for) await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`med:${ctx.params.id}:${new Date(b.scheduled_for).toISOString()}:%`]);
    await audit(ctx, b.status === "GIVEN" ? "MEDICINE_DOSE_GIVEN" : "MEDICINE_DOSE_SKIPPED", { babyId: a.babyId, table: "medicine_dose", id });
    return { id, status: b.status, given_at: givenAt };
  });
  r.get("/babies/:babyId/medicines-today", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const { dosesForDay } = await import("../notifications");
    return dosesForDay(ctx.q, a.babyId, localDateOf(new Date(), a.householdTz), a.householdTz);
  });

  // ---------- allergies ----------
  const allergyFields = {
    substance: z.string().trim().min(1).max(120), category: z.enum(["FOOD", "DRUG", "ENVIRONMENTAL", "OTHER"]).nullish(),
    reaction_text: z.string().trim().max(1000).nullish(), severity_reported: z.enum(["MILD", "MODERATE", "SEVERE", "UNKNOWN"]).default("UNKNOWN"),
    status: z.enum(["SUSPECTED", "CONFIRMED_BY_DOCTOR"]), discovered_on: zDate.nullish(), doctor_id: z.string().uuid().nullish(),
    notes: z.string().trim().max(2000).nullish(), is_active: z.boolean().optional(),
  };
  const ALG = `SELECT id, baby_id, substance, category, reaction_text, severity_reported, status, to_char(discovered_on,'YYYY-MM-DD') AS discovered_on, doctor_id, notes, is_active, version, created_at FROM allergy`;
  r.get("/babies/:babyId/allergies", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const p = await ctx.q.one<{ nka_confirmed_at: Date | null }>("SELECT nka_confirmed_at FROM baby_profile WHERE baby_id = $1", [a.babyId]);
    return { data: await ctx.q(`${ALG} WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY is_active DESC, created_at`, [a.babyId]), nka_confirmed_at: p?.nka_confirmed_at ?? null };
  });
  r.post("/babies/:babyId/allergies", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object(allergyFields));
    const id = uuidv7();
    await ctx.q(`INSERT INTO allergy(id, baby_id, substance, category, reaction_text, severity_reported, status, discovered_on, doctor_id, notes, is_active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, a.babyId, b.substance, b.category ?? null, b.reaction_text ?? null, b.severity_reported, b.status, b.discovered_on ?? null, b.doctor_id ?? null, b.notes ?? null, b.is_active ?? true, ctx.session!.userId]);
    await ctx.q("UPDATE baby_profile SET nka_confirmed_at = NULL WHERE baby_id = $1", [a.babyId]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "ALLERGY", occurredAt: b.discovered_on ? `${b.discovered_on}T12:00:00Z` : new Date().toISOString(), tz: a.householdTz, table: "allergy", id, title: `Allergy recorded · ${b.substance} (${b.status === "CONFIRMED_BY_DOCTOR" ? "confirmed" : "suspected"})`, importance: 2 });
    await audit(ctx, "ALLERGY_CREATE", { babyId: a.babyId, table: "allergy", id });
    return ctx.q.one(`${ALG} WHERE id = $1`, [id]);
  });
  r.patch("/babies/:babyId/allergies/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(allergyFields).partial());
    await versionedUpdate(ctx.q, "allergy", ctx.params.id, a.babyId, v, Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    await audit(ctx, "ALLERGY_UPDATE", { babyId: a.babyId, table: "allergy", id: ctx.params.id });
    return ctx.q.one(`${ALG} WHERE id = $1`, [ctx.params.id]);
  });
  r.delete("/babies/:babyId/allergies/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "allergy", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "ALLERGY_DELETE", { babyId: a.babyId, table: "allergy", id: ctx.params.id });
    return null;
  });
  r.post("/babies/:babyId/allergies/confirm-none", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const active = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM allergy WHERE baby_id = $1 AND is_active AND deleted_at IS NULL", [a.babyId]);
    if ((active?.n ?? 0) > 0) throw badRequest("Active allergies are recorded. Deactivate them first.");
    const row = await ctx.q.one("UPDATE baby_profile SET nka_confirmed_at = now() WHERE baby_id = $1 RETURNING nka_confirmed_at", [a.babyId]);
    await audit(ctx, "NKA_CONFIRMED", { babyId: a.babyId, table: "baby_profile", id: a.babyId });
    return row;
  });
}

async function upsertSchedule(q: import("../db").Q, medicineId: string, babyId: string, s: z.infer<typeof scheduleSchema>, tz: string) {
  await q(`INSERT INTO medicine_schedule(medicine_id, baby_id, kind, times_of_day, every_n_hours, anchor_time, tz, reminders_enabled, allow_quiet_hours)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (medicine_id) DO UPDATE SET kind = EXCLUDED.kind, times_of_day = EXCLUDED.times_of_day, every_n_hours = EXCLUDED.every_n_hours, anchor_time = EXCLUDED.anchor_time,
      tz = EXCLUDED.tz, reminders_enabled = EXCLUDED.reminders_enabled, allow_quiet_hours = EXCLUDED.allow_quiet_hours, updated_at = now()`,
    [medicineId, babyId, s.kind, s.kind === "TIMES_OF_DAY" ? s.times_of_day : null, s.kind === "EVERY_N_HOURS" ? s.every_n_hours : null, s.anchor_time ?? (s.kind === "EVERY_N_HOURS" ? "08:00" : null), s.tz ?? tz, s.reminders_enabled, s.allow_quiet_hours]);
}
