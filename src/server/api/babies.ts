import "server-only";
import { z } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { calculateBabyAge, validateBirth, AgeError, localDateOf, isValidIanaZone } from "@/lib/age";
import { ApiError, badRequest, conflict, notFound, forbidden, requireIfMatch, zDate, type Ctx, type Router } from "../http";
import { audit, requireBaby, upsertTimeline, requireStepUp, type BabyAccess } from "../core";
import { derivePopulations, categoriesOf } from "../reference/engine";
import { randomToken, sha256 } from "../crypto";
import { sendEmail } from "../delivery";
import { env } from "../env";
import { dailyFeedingSummary } from "./feedings";
import { nextVaccine } from "./vaccinations";

export const COLOURS = ["PEACH", "SKY", "MINT", "LILAC", "BUTTER", "ROSE"] as const;

const babyBase = z.object({
  first_name: z.string().trim().min(1).max(60),
  nickname: z.string().trim().max(40).nullish(),
  sex: z.enum(["FEMALE", "MALE", "NOT_STATED"]),
  birth_date: zDate,
  birth_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullish(),
  birth_tz: z.string().default("Asia/Kolkata"),
  multiple_birth_group_id: z.string().uuid().nullish(),
  birth_order: z.number().int().min(1).max(8).nullish(),
  colour_token: z.enum(COLOURS).optional(),
});
const profileSchema = z.object({
  birth_weight_kg: z.number().positive().lt(10).nullish(),
  birth_length_cm: z.number().positive().lt(80).nullish(),
  birth_hc_cm: z.number().positive().lt(60).nullish(),
  ga_weeks: z.number().int().min(20).max(45).nullish(),
  ga_days: z.number().int().min(0).max(6).nullish(),
  ga_unknown: z.boolean().optional(),
  unable_to_breastfeed: z.boolean().nullish(),
  show_clinical_references: z.boolean().optional(),
});
const createSchema = babyBase.merge(profileSchema).extend({
  schedule_id: z.enum(["GOVERNMENT_OF_INDIA_UIP", "IAP_RECOMMENDED_SCHEDULE"]).default("GOVERNMENT_OF_INDIA_UIP"),
  confirm_weight: z.boolean().optional(),
  force: z.boolean().optional(),
});

function nameSimilar(a: string, b: string) {
  const n = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-zऀ-ॿ]/g, "");
  const x = n(a), y = n(b);
  return x === y || (x.length > 2 && y.length > 2 && (x.startsWith(y) || y.startsWith(x)));
}

export async function babyDto(ctx: Ctx, a: BabyAccess) {
  const p = await ctx.q.one<Record<string, unknown>>("SELECT * FROM baby_profile WHERE baby_id = $1", [a.babyId]);
  const age = calculateBabyAge({ birthDate: a.baby.birth_date, birthTime: a.baby.birth_time, birthTz: a.baby.birth_tz }, new Date(), a.householdTz);
  const bw = p?.birth_weight_kg != null ? Number(p.birth_weight_kg) : null;
  const pops = derivePopulations({ birthWeightKg: bw, gaWeeks: (p?.ga_weeks as number) ?? null, gaUnknown: !!p?.ga_unknown });
  const allergies = await ctx.q("SELECT id, substance, status, severity_reported FROM allergy WHERE baby_id = $1 AND is_active AND deleted_at IS NULL ORDER BY created_at", [a.babyId]);
  const sched = await ctx.q.one("SELECT schedule_id, je_opt_in FROM baby_schedule_selection WHERE baby_id = $1 AND ended_at IS NULL", [a.babyId]);
  return {
    ...a.baby, household_timezone: a.householdTz, my_role: a.role, can_view_documents: a.canViewDocuments || a.role === "OWNER" || a.role === "GUARDIAN",
    profile: p ? { ...p, birth_weight_kg: bw, birth_length_cm: p.birth_length_cm != null ? Number(p.birth_length_cm) : null, birth_hc_cm: p.birth_hc_cm != null ? Number(p.birth_hc_cm) : null } : null,
    age, categories: categoriesOf(pops), allergies, nka_confirmed_at: p?.nka_confirmed_at ?? null, schedule: sched,
  };
}

export function registerBabies(r: Router) {
  r.get("/home", async (ctx) => {
    const ids = await ctx.q<{ baby_id: string }>(
      `SELECT m.baby_id FROM baby_membership m JOIN baby b ON b.id = m.baby_id WHERE m.user_id = $1 AND m.revoked_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL ORDER BY b.birth_date, b.birth_order NULLS LAST, b.first_name`,
      [ctx.session!.userId]);
    const babies = [];
    for (const { baby_id } of ids) {
      const a = await requireBaby(ctx, baby_id, "READ");
      const dto = await babyDto(ctx, a);
      const today = localDateOf(new Date(), a.householdTz);
      const feeding = await dailyFeedingSummary(ctx, a, today);
      const w = await ctx.q.one("SELECT weight_kg, to_char(local_date,'YYYY-MM-DD') AS local_date FROM weight_measurement WHERE baby_id = $1 AND weight_kg IS NOT NULL AND deleted_at IS NULL ORDER BY measured_at DESC LIMIT 1", [baby_id]);
      const appt = await ctx.q.one("SELECT id, starts_at, purpose FROM appointment WHERE baby_id = $1 AND status = 'SCHEDULED' AND starts_at >= now() AND deleted_at IS NULL ORDER BY starts_at LIMIT 1", [baby_id]);
      const vac = await nextVaccine(ctx, a).catch(() => null);
      const docIssues = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM medical_document WHERE baby_id = $1 AND scan_status IN ('INFECTED','ERROR','REJECTED') AND deleted_at IS NULL AND created_at > now() - interval '7 days'", [baby_id]).catch(() => ({ n: 0 }));
      const alerts: string[] = [];
      if (dto.allergies.length) alerts.push("ALLERGIES_RECORDED");
      if (vac?.status === "PAST_STATED_AGE_LIMIT") alerts.push("VACCINE_PAST_STATED_AGE");
      if ((docIssues?.n ?? 0) > 0) alerts.push("DOCUMENT_BLOCKED");
      babies.push({ baby: dto, today: feeding, latest_weight: w ? { weight_kg: Number(w.weight_kg), local_date: w.local_date } : null, next_vaccine: vac, next_appointment: appt, alerts });
    }
    return { babies };
  });

  r.get("/babies", async (ctx) => {
    const rows = await ctx.q<{ baby_id: string }>(
      `SELECT m.baby_id FROM baby_membership m JOIN baby b ON b.id = m.baby_id WHERE m.user_id = $1 AND m.revoked_at IS NULL AND b.deleted_at IS NULL ORDER BY b.birth_date, b.first_name`, [ctx.session!.userId]);
    const data = [];
    for (const r0 of rows) data.push(await babyDto(ctx, await requireBaby(ctx, r0.baby_id, "READ")));
    return { data, next_cursor: null };
  });

  r.post("/babies", async (ctx) => {
    const b = await ctx.body(createSchema);
    const uid = ctx.session!.userId;
    const hh = await ctx.q.one<{ household_id: string; timezone: string }>(
      "SELECT h.id AS household_id, h.timezone FROM household_member hm JOIN household h ON h.id = hm.household_id WHERE hm.user_id = $1 AND hm.left_at IS NULL ORDER BY hm.is_owner DESC LIMIT 1", [uid]);
    if (!hh) throw new ApiError(403, "REGISTRATION_INCOMPLETE", "Please complete registration first");
    if (!isValidIanaZone(b.birth_tz)) throw badRequest("Unknown birth timezone");
    try { validateBirth({ birthDate: b.birth_date, birthTime: b.birth_time, birthTz: b.birth_tz }, new Date(), hh.timezone); }
    catch (e) { if (e instanceof AgeError) throw badRequest(e.message, [{ field: e.code === "FUTURE_BIRTH_TIME" ? "birth_time" : "birth_date", code: e.code, message: e.message }]); throw e; }
    if (b.ga_unknown && b.ga_weeks != null) throw badRequest("Gestational age can't be both unknown and set");
    if (b.birth_weight_kg != null && (b.birth_weight_kg < 0.3 || b.birth_weight_kg > 7) && !b.confirm_weight)
      throw new ApiError(422, "CONFIRMATION_REQUIRED", "Please confirm this birth weight", "That birth weight is unusual. Check the unit (kg) and confirm.");
    // Same-DOB, similar-name duplicate check (wrong-baby prevention, spec §32.5)
    const sameDob = await ctx.q<{ id: string; first_name: string; nickname: string | null }>(
      `SELECT b.id, b.first_name, b.nickname FROM baby b JOIN baby_membership m ON m.baby_id = b.id AND m.user_id = $1 AND m.revoked_at IS NULL WHERE b.birth_date = $2 AND b.deleted_at IS NULL`, [uid, b.birth_date]);
    const similar = sameDob.filter((x) => nameSimilar(x.first_name, b.first_name));
    if (similar.length && !b.nickname) throw conflict("DUPLICATE_SUSPECTED", "A baby with a similar name and the same date of birth already exists. Add a distinguishing nickname, or check you aren't adding the same baby twice.", { similar });
    if (similar.length && !b.force && similar.some((x) => x.nickname && b.nickname && x.nickname.toLowerCase() === b.nickname.toLowerCase()))
      throw conflict("DUPLICATE_SUSPECTED", "That nickname is already used by a baby with the same date of birth.", { similar });

    const used = await ctx.q<{ colour_token: string }>(`SELECT b.colour_token FROM baby b JOIN baby_membership m ON m.baby_id = b.id AND m.user_id = $1 AND m.revoked_at IS NULL WHERE b.deleted_at IS NULL`, [uid]);
    const colour = b.colour_token ?? COLOURS.find((c) => !used.some((u) => u.colour_token === c)) ?? COLOURS[used.length % COLOURS.length];
    let groupId = b.multiple_birth_group_id ?? null;
    if (!groupId && sameDob.length) groupId = null; // siblings are linked explicitly from the UI
    const id = uuidv7();
    // insert without RETURNING: SELECT policy needs the membership row first
    await ctx.q(`INSERT INTO baby(id, household_id, first_name, nickname, colour_token, sex, birth_date, birth_time, birth_tz, multiple_birth_group_id, birth_order, created_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, hh.household_id, b.first_name, b.nickname ?? null, colour, b.sex, b.birth_date, b.birth_time ?? null, b.birth_tz, groupId, b.birth_order ?? null, uid]);
    await ctx.q("INSERT INTO baby_membership(baby_id, user_id, role, granted_by) VALUES ($1,$2,'OWNER',$2)", [id, uid]);
    await ctx.q(`INSERT INTO baby_profile(baby_id, birth_weight_kg, birth_length_cm, birth_hc_cm, ga_weeks, ga_days, ga_unknown, unable_to_breastfeed, show_clinical_references, updated_by)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, b.birth_weight_kg ?? null, b.birth_length_cm ?? null, b.birth_hc_cm ?? null, b.ga_weeks ?? null, b.ga_weeks != null ? (b.ga_days ?? 0) : null, !!b.ga_unknown, b.unable_to_breastfeed ?? null, !!b.show_clinical_references, uid]);
    await ctx.q("INSERT INTO baby_schedule_selection(id, baby_id, schedule_id, selected_by) VALUES ($1,$2,$3,$4)", [uuidv7(), id, b.schedule_id, uid]);
    const birthInstant = DateTime.fromISO(`${b.birth_date}T${b.birth_time ?? "00:00"}`, { zone: b.birth_tz }).toUTC().toISO()!;
    await upsertTimeline(ctx.q, { babyId: id, type: "BIRTH", occurredAt: birthInstant, tz: b.birth_tz, table: "baby", id, title: `${b.first_name} was born`, summary: b.birth_weight_kg ? `Birth weight ${b.birth_weight_kg} kg` : null, importance: 2 });
    if (b.birth_weight_kg || b.birth_length_cm || b.birth_hc_cm) {
      const mid = uuidv7();
      await ctx.q(`INSERT INTO weight_measurement(id, baby_id, measured_at, measured_tz, local_date, weight_kg, length_cm, length_position, head_circumference_cm, measurement_source, notes, created_by)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,'RECUMBENT',$8,'HOSPITAL','Birth measurements (from profile)',$9)`,
        [mid, id, DateTime.fromISO(`${b.birth_date}T${b.birth_time ?? "12:00"}`, { zone: b.birth_tz }).toUTC().toISO(), b.birth_tz, b.birth_date, b.birth_weight_kg ?? null, b.birth_length_cm ?? null, b.birth_hc_cm ?? null, uid]);
    }
    await audit(ctx, "BABY_CREATE", { babyId: id, table: "baby", id });
    return babyDto(ctx, await requireBaby(ctx, id, "READ"));
  });

  r.get("/babies/:babyId", async (ctx) => babyDto(ctx, await requireBaby(ctx, ctx.params.babyId, "READ")));

  r.patch("/babies/:babyId", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(babyBase.partial().extend({ archived: z.boolean().optional(), photo_document_id: z.string().uuid().nullish() }));
    const next = { birthDate: b.birth_date ?? a.baby.birth_date, birthTime: b.birth_time === undefined ? a.baby.birth_time : b.birth_time, birthTz: b.birth_tz ?? a.baby.birth_tz };
    try { validateBirth(next, new Date(), a.householdTz); } catch (e) { if (e instanceof AgeError) throw badRequest(e.message); throw e; }
    if (b.photo_document_id) {
      const d = await ctx.q.one("SELECT 1 FROM medical_document WHERE id = $1 AND baby_id = $2 AND scan_status = 'CLEAN' AND deleted_at IS NULL", [b.photo_document_id, a.babyId]);
      if (!d) throw badRequest("Photo must be a scanned document of this baby");
    }
    const rows = await ctx.q(`UPDATE baby SET first_name = coalesce($3, first_name), nickname = CASE WHEN $4::boolean THEN $5 ELSE nickname END, sex = coalesce($6, sex),
        birth_date = coalesce($7::date, birth_date), birth_time = CASE WHEN $8::boolean THEN $9::time ELSE birth_time END, birth_tz = coalesce($10, birth_tz),
        colour_token = coalesce($11, colour_token), archived_at = CASE WHEN $12::boolean IS NULL THEN archived_at WHEN $12 THEN now() ELSE NULL END,
        photo_document_id = CASE WHEN $13::boolean THEN $14::uuid ELSE photo_document_id END,
        multiple_birth_group_id = CASE WHEN $15::boolean THEN $16::uuid ELSE multiple_birth_group_id END,
        version = version + 1, updated_at = now(), updated_by = $17
      WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING id`,
      [a.babyId, v, b.first_name ?? null, b.nickname !== undefined, b.nickname ?? null, b.sex ?? null, b.birth_date ?? null, b.birth_time !== undefined, b.birth_time ?? null,
       b.birth_tz ?? null, b.colour_token ?? null, b.archived ?? null, b.photo_document_id !== undefined, b.photo_document_id ?? null,
       b.multiple_birth_group_id !== undefined, b.multiple_birth_group_id ?? null, ctx.session!.userId]);
    if (!rows.length) throw new ApiError(412, "VERSION_MISMATCH", "This record was changed by someone else");
    await audit(ctx, "BABY_UPDATE", { babyId: a.babyId, table: "baby", id: a.babyId, detail: { fields: Object.keys(b) } });
    return babyDto(ctx, await requireBaby(ctx, a.babyId, "READ"));
  });

  r.get("/babies/:babyId/profile", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    return (await babyDto(ctx, a)).profile;
  });
  r.patch("/babies/:babyId/profile", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(profileSchema.extend({ corrected_age_enabled: z.literal(false).optional() }));
    const cur = await ctx.q.one<Record<string, unknown>>("SELECT * FROM baby_profile WHERE baby_id = $1", [a.babyId]);
    const merged = { ...cur, ...b };
    if (merged.ga_unknown && merged.ga_weeks != null) throw badRequest("Gestational age can't be both unknown and set");
    const keys = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
    if (!keys.length) return (await babyDto(ctx, a)).profile;
    const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
    const rows = await ctx.q(`UPDATE baby_profile SET ${sets}, version = version + 1, updated_at = now(), updated_by = $3 WHERE baby_id = $1 AND version = $2 RETURNING baby_id`,
      [a.babyId, v, ctx.session!.userId, ...keys.map((k) => (b as Record<string, unknown>)[k] ?? null)]);
    if (!rows.length) throw new ApiError(412, "VERSION_MISMATCH", "This record was changed by someone else");
    await audit(ctx, "BABY_PROFILE_UPDATE", { babyId: a.babyId, table: "baby_profile", id: a.babyId, detail: { fields: keys } });
    return (await babyDto(ctx, a)).profile;
  });

  r.get("/babies/:babyId/age", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const at = ctx.query.get("at");
    return calculateBabyAge({ birthDate: a.baby.birth_date, birthTime: a.baby.birth_time, birthTz: a.baby.birth_tz }, at ? new Date(at) : new Date(), a.householdTz);
  });

  // ---------- members & invitations ----------
  r.get("/babies/:babyId/members", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const members = await ctx.q(`SELECT m.user_id, u.display_name, m.role, m.can_view_documents, m.granted_at FROM baby_membership m JOIN app_user u ON u.id = m.user_id WHERE m.baby_id = $1 AND m.revoked_at IS NULL ORDER BY m.granted_at`, [a.babyId]);
    const invitations = a.role === "OWNER" ? await ctx.q("SELECT id, identifier, role, can_view_documents, created_at, expires_at FROM invitation WHERE baby_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [a.babyId]) : [];
    return { members, invitations };
  });

  r.post("/babies/:babyId/members", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "OWNER");
    const b = await ctx.body(z.object({ email: z.string().email().toLowerCase().optional(), phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(), role: z.enum(["GUARDIAN", "CAREGIVER", "VIEWER"]), can_view_documents: z.boolean().default(false) })
      .refine((v) => !!v.email !== !!v.phone_e164, "Provide exactly one of email or phone_e164"));
    const token = randomToken();
    const id = uuidv7();
    const identifier = b.email ?? b.phone_e164!;
    await ctx.q("INSERT INTO invitation(id, baby_id, identifier, role, can_view_documents, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() + interval '7 days')",
      [id, a.babyId, identifier, b.role, b.role === "GUARDIAN" ? true : b.can_view_documents, sha256(token), ctx.session!.userId]);
    const link = `${env.APP_URL}/invite/${token}`;
    if (b.email) await sendEmail(b.email, "You've been invited to a family health record", `${ctx.session!.displayName} invited you to help keep a baby's health record on Baby Health. Accept within 7 days: ${link}`);
    await audit(ctx, "MEMBER_INVITED", { babyId: a.babyId, table: "invitation", id, detail: { role: b.role } });
    return { id, invite_link: link, expires_in_days: 7 };
  });

  r.post("/invitations/accept", async (ctx) => {
    const b = await ctx.body(z.object({ token: z.string().min(20).max(100) }));
    const inv = await ctx.q.one<{ id: string; baby_id: string; identifier: string; role: string; can_view_documents: boolean }>(
      "SELECT id, baby_id, identifier, role, can_view_documents FROM invitation WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [sha256(b.token)]);
    if (!inv) throw notFound("Invitation");
    const u = await ctx.q.one<{ email: string | null; phone_e164: string | null }>("SELECT email, phone_e164 FROM app_user WHERE id = $1", [ctx.session!.userId]);
    if (u?.email !== inv.identifier && u?.phone_e164 !== inv.identifier) throw new ApiError(403, "INVITATION_MISMATCH", "This invitation was sent to a different email or phone");
    await ctx.q(`INSERT INTO baby_membership(baby_id, user_id, role, can_view_documents, granted_by) VALUES ($1,$2,$3,$4,(SELECT invited_by FROM invitation WHERE id = $5))
                 ON CONFLICT (baby_id, user_id) DO UPDATE SET role = EXCLUDED.role, can_view_documents = EXCLUDED.can_view_documents, revoked_at = NULL, granted_at = now()`,
      [inv.baby_id, ctx.session!.userId, inv.role, inv.can_view_documents, inv.id]);
    await ctx.q("UPDATE invitation SET accepted_at = now(), accepted_by = $2 WHERE id = $1", [inv.id, ctx.session!.userId]);
    await audit(ctx, "INVITATION_ACCEPTED", { babyId: inv.baby_id, table: "invitation", id: inv.id });
    return { baby_id: inv.baby_id };
  });

  r.patch("/babies/:babyId/members/:userId", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "OWNER");
    requireStepUp(ctx);
    const b = await ctx.body(z.object({ role: z.enum(["OWNER", "GUARDIAN", "CAREGIVER", "VIEWER"]).optional(), can_view_documents: z.boolean().optional() }));
    if (ctx.params.userId === ctx.session!.userId && b.role && b.role !== "OWNER") {
      const owners = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM baby_membership WHERE baby_id = $1 AND role = 'OWNER' AND revoked_at IS NULL", [a.babyId]);
      if ((owners?.n ?? 0) < 2) throw new ApiError(422, "LAST_OWNER", "A baby must always have at least one owner");
    }
    const rows = await ctx.q("UPDATE baby_membership SET role = coalesce($3, role), can_view_documents = coalesce($4, can_view_documents) WHERE baby_id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING role",
      [a.babyId, ctx.params.userId, b.role ?? null, b.can_view_documents ?? null]);
    if (!rows.length) throw notFound("Member");
    await audit(ctx, "ROLE_CHANGE", { babyId: a.babyId, table: "baby_membership", id: ctx.params.userId, detail: b });
    return rows[0];
  });

  r.delete("/babies/:babyId/members/:userId", async (ctx) => {
    const isSelf = ctx.params.userId === ctx.session!.userId;
    const a = await requireBaby(ctx, ctx.params.babyId, isSelf ? "READ" : "OWNER");
    const target = await ctx.q.one<{ role: string }>("SELECT role FROM baby_membership WHERE baby_id = $1 AND user_id = $2 AND revoked_at IS NULL", [a.babyId, ctx.params.userId]);
    if (!target) throw notFound("Member");
    if (target.role === "OWNER") {
      const owners = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM baby_membership WHERE baby_id = $1 AND role = 'OWNER' AND revoked_at IS NULL", [a.babyId]);
      if ((owners?.n ?? 0) < 2) throw new ApiError(422, "LAST_OWNER", "A baby must always have at least one owner");
    }
    await ctx.q("UPDATE baby_membership SET revoked_at = now() WHERE baby_id = $1 AND user_id = $2", [a.babyId, ctx.params.userId]);
    await audit(ctx, "MEMBER_REVOKED", { babyId: a.babyId, table: "baby_membership", id: ctx.params.userId });
    return null;
  });

  r.delete("/babies/:babyId/invitations/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "OWNER");
    const rows = await ctx.q("UPDATE invitation SET revoked_at = now() WHERE id = $1 AND baby_id = $2 AND accepted_at IS NULL RETURNING id", [ctx.params.id, a.babyId]);
    if (!rows.length) throw notFound("Invitation");
    await audit(ctx, "INVITATION_REVOKED", { babyId: a.babyId, table: "invitation", id: ctx.params.id });
    return null;
  });

  void forbidden;
}
