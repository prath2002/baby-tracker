import "server-only";
import { z } from "zod";
import { uuidv7 } from "@/lib/ids";
import { isValidIanaZone } from "@/lib/age";
import { badRequest, notFound, requireIfMatch, zDateTime, type Ctx, type Router } from "../http";
import { audit, requireBaby, requireHousehold, softDelete, upsertTimeline, versionedUpdate } from "../core";

const PURPOSES = ["ROUTINE_CHECKUP", "VACCINATION", "FOLLOW_UP", "SPECIALIST", "LAB_TEST", "OTHER"] as const;
const PURPOSE_LABEL: Record<string, string> = { ROUTINE_CHECKUP: "Routine check-up", VACCINATION: "Vaccination visit", FOLLOW_UP: "Follow-up", SPECIALIST: "Specialist", LAB_TEST: "Lab test", OTHER: "Appointment" };

const apptFields = {
  doctor_id: z.string().uuid().nullish(),
  clinic_id: z.string().uuid().nullish(),
  starts_at: zDateTime,
  ends_at: zDateTime.nullish(),
  tz: z.string().max(64).optional(),
  purpose: z.enum(PURPOSES),
  status: z.enum(["SCHEDULED", "COMPLETED", "CANCELLED", "MISSED"]).optional(),
  notes_before: z.string().trim().max(4000).nullish(),
  notes_after: z.string().trim().max(4000).nullish(),
  reminder_offsets_min: z.array(z.number().int().min(0).max(60 * 24 * 14)).max(4).optional(),
};
const SELECT = `SELECT a.id, a.baby_id, a.doctor_id, d.name AS doctor_name, a.clinic_id, c.name AS clinic_name, a.starts_at, a.ends_at, a.tz, a.purpose, a.status, a.group_id,
  a.notes_before, a.notes_after, a.reminder_offsets_min, a.version, a.created_at FROM appointment a LEFT JOIN doctor d ON d.id = a.doctor_id LEFT JOIN clinic c ON c.id = a.clinic_id`;

async function checkDirectory(ctx: Ctx, householdId: string, doctorId?: string | null, clinicId?: string | null) {
  if (doctorId && !(await ctx.q.one("SELECT 1 FROM doctor WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL", [doctorId, householdId]))) throw badRequest("Unknown doctor");
  if (clinicId && !(await ctx.q.one("SELECT 1 FROM clinic WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL", [clinicId, householdId]))) throw badRequest("Unknown clinic");
}

export function registerCare(r: Router) {
  for (const kind of ["doctors", "clinics"] as const) {
    const table = kind === "doctors" ? "doctor" : "clinic";
    const schema = kind === "doctors"
      ? z.object({ name: z.string().trim().min(1).max(120), specialty: z.string().trim().max(80).nullish(), phone: z.string().trim().max(30).nullish(), notes: z.string().trim().max(1000).nullish() })
      : z.object({ name: z.string().trim().min(1).max(160), address: z.string().trim().max(400).nullish(), phone: z.string().trim().max(30).nullish() });
    r.get(`/households/:householdId/${kind}`, async (ctx) => {
      await requireHousehold(ctx, ctx.params.householdId);
      return { data: await ctx.q(`SELECT * FROM ${table} WHERE household_id = $1 AND deleted_at IS NULL ORDER BY name`, [ctx.params.householdId]), next_cursor: null };
    });
    r.post(`/households/:householdId/${kind}`, async (ctx) => {
      await requireHousehold(ctx, ctx.params.householdId, true);
      const b = await ctx.body(schema) as Record<string, unknown>;
      const id = uuidv7();
      const cols = Object.keys(b);
      await ctx.q(`INSERT INTO ${table}(id, household_id, created_by, ${cols.join(",")}) VALUES ($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(",")})`, [id, ctx.params.householdId, ctx.session!.userId, ...cols.map((k) => b[k] ?? null)]);
      await audit(ctx, `${table.toUpperCase()}_CREATE`, { table, id });
      return ctx.q.one(`SELECT * FROM ${table} WHERE id = $1`, [id]);
    });
    r.patch(`/households/:householdId/${kind}/:id`, async (ctx) => {
      await requireHousehold(ctx, ctx.params.householdId, true);
      const b = await ctx.body(schema.partial()) as Record<string, unknown>;
      const cols = Object.keys(b).filter((k) => b[k] !== undefined);
      if (!cols.length) return ctx.q.one(`SELECT * FROM ${table} WHERE id = $1`, [ctx.params.id]);
      const rows = await ctx.q(`UPDATE ${table} SET ${cols.map((k, i) => `${k} = $${i + 3}`).join(", ")}, updated_at = now(), version = version + 1 WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL RETURNING *`,
        [ctx.params.id, ctx.params.householdId, ...cols.map((k) => b[k] ?? null)]);
      if (!rows.length) throw notFound();
      await audit(ctx, `${table.toUpperCase()}_UPDATE`, { table, id: ctx.params.id });
      return rows[0];
    });
    r.delete(`/households/:householdId/${kind}/:id`, async (ctx) => {
      await requireHousehold(ctx, ctx.params.householdId, true);
      const rows = await ctx.q(`UPDATE ${table} SET deleted_at = now() WHERE id = $1 AND household_id = $2 AND deleted_at IS NULL RETURNING id`, [ctx.params.id, ctx.params.householdId]);
      if (!rows.length) throw notFound();
      await audit(ctx, `${table.toUpperCase()}_DELETE`, { table, id: ctx.params.id });
      return null;
    });
  }

  r.get("/appointments", async (ctx) => {
    const babyFilter = ctx.query.get("baby_id");
    const status = ctx.query.get("status");
    const rows = await ctx.q(`${SELECT} JOIN baby_membership m ON m.baby_id = a.baby_id AND m.user_id = $1 AND m.revoked_at IS NULL
      WHERE a.deleted_at IS NULL AND ($2::uuid IS NULL OR a.baby_id = $2) AND ($3::text IS NULL OR a.status = $3)
        AND ($4::timestamptz IS NULL OR a.starts_at >= $4) AND ($5::timestamptz IS NULL OR a.starts_at <= $5)
      ORDER BY a.starts_at ${ctx.query.get("sort") === "-starts_at" ? "DESC" : "ASC"} LIMIT 200`,
      [ctx.session!.userId, babyFilter, status, ctx.query.get("from"), ctx.query.get("to")]);
    return { data: rows, next_cursor: null };
  });

  r.post("/babies/:babyId/appointments", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ ...apptFields, sibling_baby_ids: z.array(z.string().uuid()).max(7).optional() }));
    if (b.ends_at && b.ends_at <= b.starts_at) throw badRequest("End time must be after the start time");
    const tz = b.tz && isValidIanaZone(b.tz) ? b.tz : a.householdTz;
    await checkDirectory(ctx, a.householdId, b.doctor_id, b.clinic_id);
    const babies = [a];
    for (const sid of b.sibling_baby_ids ?? []) if (sid !== a.babyId) babies.push(await requireBaby(ctx, sid, "MANAGE"));
    const groupId = babies.length > 1 ? uuidv7() : null;
    const ids: string[] = [];
    for (const bb of babies) {
      const id = uuidv7();
      ids.push(id);
      await ctx.q(`INSERT INTO appointment(id, baby_id, doctor_id, clinic_id, starts_at, ends_at, tz, purpose, status, group_id, notes_before, notes_after, reminder_offsets_min, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, bb.babyId, b.doctor_id ?? null, b.clinic_id ?? null, b.starts_at, b.ends_at ?? null, tz, b.purpose, b.status ?? "SCHEDULED", groupId, b.notes_before ?? null, b.notes_after ?? null, b.reminder_offsets_min ?? [1440, 120], ctx.session!.userId]);
      await upsertTimeline(ctx.q, { babyId: bb.babyId, type: "APPOINTMENT", occurredAt: b.starts_at, tz, table: "appointment", id, title: PURPOSE_LABEL[b.purpose] });
      await audit(ctx, "APPOINTMENT_CREATE", { babyId: bb.babyId, table: "appointment", id });
    }
    return { ids, group_id: groupId, appointment: await ctx.q.one(`${SELECT} WHERE a.id = $1`, [ids[0]]) };
  });

  r.get("/babies/:babyId/appointments/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const appt = await ctx.q.one<{ starts_at: Date }>(`${SELECT} WHERE a.id = $1 AND a.baby_id = $2 AND a.deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!appt) throw notFound("Appointment");
    const prev = await ctx.q.one<{ starts_at: Date }>("SELECT starts_at FROM appointment WHERE baby_id = $1 AND status = 'COMPLETED' AND starts_at < $2 AND deleted_at IS NULL ORDER BY starts_at DESC LIMIT 1", [a.babyId, appt.starts_at]);
    const since = prev?.starts_at ?? new Date(Date.now() - 30 * 86400_000);
    const prep = {
      since,
      feeds: await ctx.q.one("SELECT count(*)::int AS feeds, count(*) FILTER (WHERE feeding_type = 'DIRECT_BREASTFEEDING')::int AS bf_sessions, coalesce(sum(quantity_ml),0)::float AS measured_ml FROM feeding WHERE baby_id = $1 AND occurred_at >= $2 AND deleted_at IS NULL", [a.babyId, since]),
      weights: await ctx.q("SELECT to_char(local_date,'YYYY-MM-DD') AS local_date, weight_kg::float, length_cm::float, head_circumference_cm::float, measurement_source FROM weight_measurement WHERE baby_id = $1 AND measured_at >= $2 AND deleted_at IS NULL ORDER BY measured_at", [a.babyId, since]),
      vaccines: await ctx.q("SELECT vaccine_name_as_recorded, dose_label, to_char(given_on,'YYYY-MM-DD') AS given_on FROM vaccination WHERE baby_id = $1 AND given_on >= $2::date AND deleted_at IS NULL", [a.babyId, since]),
      medicines: await ctx.q("SELECT medicine_name, status FROM medicine WHERE baby_id = $1 AND deleted_at IS NULL AND (status = 'ACTIVE' OR updated_at >= $2)", [a.babyId, since]),
      allergies: await ctx.q("SELECT substance, status, severity_reported FROM allergy WHERE baby_id = $1 AND is_active AND deleted_at IS NULL", [a.babyId]),
    };
    const linked = {
      vaccinations: await ctx.q("SELECT id, vaccine_name_as_recorded, dose_label FROM vaccination WHERE appointment_id = $1 AND deleted_at IS NULL", [ctx.params.id]),
      prescriptions: await ctx.q("SELECT id, to_char(prescribed_on,'YYYY-MM-DD') AS prescribed_on FROM prescription WHERE appointment_id = $1 AND deleted_at IS NULL", [ctx.params.id]),
    };
    return { ...appt, visit_prep: prep, linked };
  });

  r.patch("/babies/:babyId/appointments/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(apptFields).partial());
    await checkDirectory(ctx, a.householdId, b.doctor_id, b.clinic_id);
    const sets = Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined));
    const row = await versionedUpdate<{ starts_at: Date; ends_at: Date | null; purpose: string; tz: string; status: string }>(ctx.q, "appointment", ctx.params.id, a.babyId, v, sets, ctx.session!.userId);
    if (row.ends_at && row.ends_at <= row.starts_at) throw badRequest("End time must be after the start time");
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: "APPOINTMENT", occurredAt: row.starts_at, tz: row.tz, table: "appointment", id: ctx.params.id, title: `${PURPOSE_LABEL[row.purpose]}${row.status !== "SCHEDULED" ? ` · ${row.status.toLowerCase()}` : ""}` });
    if (row.status !== "SCHEDULED") await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`appt:${ctx.params.id}:%`]);
    await audit(ctx, "APPOINTMENT_UPDATE", { babyId: a.babyId, table: "appointment", id: ctx.params.id, detail: { fields: Object.keys(sets) } });
    return ctx.q.one(`${SELECT} WHERE a.id = $1`, [ctx.params.id]);
  });

  r.delete("/babies/:babyId/appointments/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "appointment", ctx.params.id, a.babyId, ctx.session!.userId);
    await ctx.q("UPDATE notification SET status = 'CANCELLED' WHERE dedupe_key LIKE $1 AND status = 'PENDING'", [`appt:${ctx.params.id}:%`]);
    await audit(ctx, "APPOINTMENT_DELETE", { babyId: a.babyId, table: "appointment", id: ctx.params.id });
    return null;
  });
}
