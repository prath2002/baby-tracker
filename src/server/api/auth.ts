import "server-only";
import { z } from "zod";
import { uuidv7, isUuid } from "@/lib/ids";
import { isValidIanaZone } from "@/lib/age";
import { ApiError, badRequest, conflict, rateLimit, type Ctx, type Router, notFound } from "../http";
import { otpCode, hmac, safeEqualHex, hashPassword, verifyPassword, dummyPasswordHash } from "../crypto";
import { sendEmail, sendSms } from "../delivery";
import { createSession, sessionCookie, clearSessionCookie } from "../auth/session";
import { withSystem } from "../db";
import { audit, requireStepUp } from "../core";
import { env } from "../env";

const OTP_TTL_MIN = 5, MAX_ATTEMPTS = 5, RESEND_AFTER_S = 30;

const identifierSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone_e164: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use international format, e.g. +919876543210").optional(),
  purpose: z.enum(["LOGIN", "STEP_UP"]).default("LOGIN"),
}).refine((v) => !!v.email !== !!v.phone_e164, { message: "Provide exactly one of email or phone_e164" });

const PASSWORD_MIN = 10, PASSWORD_MAX = 200;
const passwordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`).max(PASSWORD_MAX),
});

/** Opens a session after any successful sign-in (one-time code or password). */
async function completeLogin(ctx: Ctx, user: { id: string; status: string; guardian_attested_at: Date | null }, isNew: boolean, channel: string, deviceName?: string) {
  if (user.status !== "ACTIVE") throw new ApiError(403, "ACCOUNT_NOT_ACTIVE", "This account is not active");
  const s = await createSession(user.id, { ip: ctx.ip, userAgent: ctx.req.headers.get("user-agent"), deviceName });
  ctx.setCookies.push(sessionCookie(s.token));
  await withSystem((q) => q("SELECT audit_append($1,$2,$3,NULL,'LOGIN','user_session',$4,$5,$6)",
    [user.id, ctx.ip, s.id, s.id, JSON.stringify({ new_user: isNew, channel }), ctx.requestId]));
  // Notify other active sessions of a new-device login (in-app inbox)
  await withSystem((q) => q(`INSERT INTO notification(id, user_id, kind, title, body, scheduled_for, dedupe_key)
    SELECT $1, $2, 'NEW_DEVICE_LOGIN', 'New sign-in to your account', 'If this wasn''t you, revoke the session in Account → Devices.', now(), $4
    WHERE EXISTS (SELECT 1 FROM user_session WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL)`, [uuidv7(), user.id, s.id, `login:${s.id}`]));
  const consent = await withSystem((q) => q.one("SELECT 1 FROM consent_record WHERE user_id = $1 AND purpose = 'CORE_PROCESSING' AND granted LIMIT 1", [user.id]));
  return { user_id: user.id, new_user: isNew, registration_complete: !!user.guardian_attested_at && !!consent };
}

export function registerAuth(r: Router) {
  r.post("/auth/otp/request", async (ctx) => {
    const b = await ctx.body(identifierSchema);
    const identifier = b.email ?? b.phone_e164!;
    const channel = b.email ? "EMAIL" : "SMS";
    await rateLimit(`otp:id:${identifier}`, 3600, 5);
    await rateLimit(`otp:ip:${ctx.ip}`, 3600, 20);
    let userId: string | null = null;
    if (b.purpose === "STEP_UP") {
      if (!ctx.session) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in");
      const u = await ctx.q.one<{ email: string | null; phone_e164: string | null }>("SELECT email, phone_e164 FROM app_user WHERE id = $1", [ctx.session.userId]);
      if (!u || (u.email !== identifier && u.phone_e164 !== identifier)) throw badRequest("Use the email or phone on your account");
      userId = ctx.session.userId;
    }
    const recent = await withSystem((q) => q.one<{ created_at: Date }>(
      "SELECT created_at FROM auth_challenge WHERE identifier = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1", [identifier]));
    if (recent && Date.now() - recent.created_at.getTime() < RESEND_AFTER_S * 1000)
      throw new ApiError(429, "RESEND_TOO_SOON", "Please wait before requesting another code", undefined, undefined, { "Retry-After": String(RESEND_AFTER_S) });
    const id = uuidv7();
    const code = otpCode();
    await withSystem((q) => q(
      `INSERT INTO auth_challenge(id, identifier, channel, purpose, user_id, code_hash, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '${OTP_TTL_MIN} minutes')`,
      [id, identifier, channel, b.purpose, userId, hmac(`${id}:${code}`)]));
    const text = `Your Baby Health sign-in code is ${code}. It expires in ${OTP_TTL_MIN} minutes. If you didn't request it, ignore this message.`;
    if (channel === "EMAIL") await sendEmail(identifier, "Your sign-in code", text);
    else await sendSms(identifier, text);
    // Same response whether or not an account exists (no enumeration).
    return new Response(JSON.stringify({ challenge_id: id, resend_after_s: RESEND_AFTER_S, expires_in_s: OTP_TTL_MIN * 60 }), { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  }, { auth: "public", rateLimit: { bucket: "otp-request", perMinute: 10 } });

  r.post("/auth/otp/verify", async (ctx) => {
    const b = await ctx.body(z.object({ challenge_id: z.string(), code: z.string().regex(/^\d{6}$/), device_name: z.string().max(80).optional() }));
    if (!isUuid(b.challenge_id)) throw badRequest("Invalid challenge");
    const result = await withSystem(async (q) => {
      const ch = await q.one<{ id: string; identifier: string; channel: string; purpose: string; user_id: string | null; code_hash: string; attempts: number; expires_at: Date; consumed_at: Date | null }>(
        "SELECT * FROM auth_challenge WHERE id = $1 FOR UPDATE", [b.challenge_id]);
      if (!ch || ch.consumed_at || ch.expires_at.getTime() < Date.now()) return { error: new ApiError(400, "CODE_EXPIRED", "This code has expired. Request a new one.") };
      if (ch.attempts >= MAX_ATTEMPTS) return { error: new ApiError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Request a new code.") };
      if (!safeEqualHex(hmac(`${ch.id}:${b.code}`), ch.code_hash)) {
        await q("UPDATE auth_challenge SET attempts = attempts + 1 WHERE id = $1", [ch.id]);
        return { error: new ApiError(400, "CODE_INCORRECT", "That code isn't right", `${MAX_ATTEMPTS - ch.attempts - 1} attempts left.`) };
      }
      await q("UPDATE auth_challenge SET consumed_at = now() WHERE id = $1", [ch.id]);
      return { ch };
    });
    if ("error" in result) throw result.error;
    const ch = result.ch!;

    if (ch.purpose === "STEP_UP") {
      if (!ctx.session || ctx.session.userId !== ch.user_id) throw new ApiError(401, "UNAUTHENTICATED", "Please sign in");
      await withSystem((q) => q("UPDATE user_session SET step_up_at = now() WHERE id = $1", [ctx.session!.sessionId]));
      await audit(ctx, "STEP_UP_VERIFIED", { table: "user_session", id: ctx.session.sessionId });
      return { step_up: true };
    }

    const { user, isNew } = await withSystem(async (q) => {
      const col = ch.channel === "EMAIL" ? "email" : "phone_e164";
      const verifiedCol = ch.channel === "EMAIL" ? "email_verified_at" : "phone_verified_at";
      let u = await q.one<{ id: string; status: string; guardian_attested_at: Date | null; display_name: string }>(`SELECT id, status, guardian_attested_at, display_name FROM app_user WHERE ${col} = $1`, [ch.identifier]);
      let created = false;
      if (!u) {
        const id = uuidv7();
        await q(`INSERT INTO app_user(id, display_name, ${col}, ${verifiedCol}) VALUES ($1, 'Parent', $2, now())`, [id, ch.identifier]);
        u = { id, status: "ACTIVE", guardian_attested_at: null, display_name: "Parent" };
        created = true;
      } else {
        await q(`UPDATE app_user SET ${verifiedCol} = coalesce(${verifiedCol}, now()) WHERE id = $1`, [u.id]);
      }
      // Accept pending invitations addressed to this identifier
      return { user: u, isNew: created };
    });
    return completeLogin(ctx, user, isNew, ch.channel, b.device_name);
  }, { auth: "public", rateLimit: { bucket: "otp-verify", perMinute: 20 } });

  // ---------- email + password ----------
  r.post("/auth/password/register", async (ctx) => {
    const b = await ctx.body(passwordSchema.extend({ device_name: z.string().max(80).optional() }));
    await rateLimit(`pw-register:ip:${ctx.ip}`, 3600, 10);
    const hash = await hashPassword(b.password);
    const user = await withSystem(async (q) => {
      if (await q.one("SELECT 1 FROM app_user WHERE email = $1", [b.email]))
        throw conflict("ACCOUNT_EXISTS", "An account with this email already exists. Sign in instead.");
      const id = uuidv7();
      await q("INSERT INTO app_user(id, display_name, email) VALUES ($1, 'Parent', $2)", [id, b.email]);
      await q("INSERT INTO user_password(user_id, password_hash) VALUES ($1, $2)", [id, hash]);
      return { id, status: "ACTIVE", guardian_attested_at: null };
    });
    return completeLogin(ctx, user, true, "PASSWORD", b.device_name);
  }, { auth: "public", rateLimit: { bucket: "pw-register", perMinute: 5 } });

  r.post("/auth/password/login", async (ctx) => {
    const b = await ctx.body(z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(1).max(PASSWORD_MAX), device_name: z.string().max(80).optional() }));
    await rateLimit(`pw-login:id:${b.email}`, 900, 10);
    await rateLimit(`pw-login:ip:${ctx.ip}`, 900, 50);
    const row = await withSystem((q) => q.one<{ id: string; status: string; guardian_attested_at: Date | null; password_hash: string }>(
      "SELECT u.id, u.status, u.guardian_attested_at, p.password_hash FROM app_user u JOIN user_password p ON p.user_id = u.id WHERE u.email = $1", [b.email]));
    const ok = await verifyPassword(b.password, row?.password_hash ?? await dummyPasswordHash());
    // Same answer for unknown email and wrong password (no enumeration).
    if (!row || !ok) throw new ApiError(400, "CREDENTIALS_INCORRECT", "Email or password is incorrect");
    return completeLogin(ctx, row, false, "PASSWORD", b.device_name);
  }, { auth: "public", rateLimit: { bucket: "pw-login", perMinute: 20 } });

  r.post("/auth/password/step-up", async (ctx) => {
    const b = await ctx.body(z.object({ password: z.string().min(1).max(PASSWORD_MAX) }));
    await rateLimit(`pw-stepup:user:${ctx.session!.userId}`, 900, 10);
    const row = await withSystem((q) => q.one<{ password_hash: string }>("SELECT password_hash FROM user_password WHERE user_id = $1", [ctx.session!.userId]));
    if (!row) throw badRequest("This account has no password. Use a one-time code.");
    if (!(await verifyPassword(b.password, row.password_hash))) throw new ApiError(400, "CREDENTIALS_INCORRECT", "That password isn't right");
    await withSystem((q) => q("UPDATE user_session SET step_up_at = now() WHERE id = $1", [ctx.session!.sessionId]));
    await audit(ctx, "STEP_UP_VERIFIED", { table: "user_session", id: ctx.session!.sessionId, detail: { method: "PASSWORD" } });
    return { step_up: true };
  }, { auth: "user" });

  r.post("/auth/logout", async (ctx) => {
    await ctx.q("UPDATE user_session SET revoked_at = now(), revoked_reason = 'LOGOUT' WHERE id = $1", [ctx.session!.sessionId]);
    await audit(ctx, "LOGOUT", { table: "user_session", id: ctx.session!.sessionId });
    ctx.setCookies.push(clearSessionCookie());
    return null;
  }, { auth: "user" });

  // ---------- me ----------
  r.get("/me", async (ctx) => {
    const u = await ctx.q.one(`SELECT id, display_name, email, phone_e164, locale, settings, guardian_attested_at, adult_verified_at, adult_verification_method, created_at FROM app_user WHERE id = $1`, [ctx.session!.userId]);
    const households = await ctx.q(`SELECT h.id, h.name, h.timezone, hm.is_owner FROM household h JOIN household_member hm ON hm.household_id = h.id WHERE hm.user_id = $1 AND hm.left_at IS NULL`, [ctx.session!.userId]);
    const hasPassword = !!(await withSystem((q) => q.one("SELECT 1 FROM user_password WHERE user_id = $1", [ctx.session!.userId])));
    return { ...u, households, has_password: hasPassword, registration_complete: ctx.session!.registrationComplete, privacy_notice_version: env.PRIVACY_NOTICE_VERSION, grievance_contact: env.GRIEVANCE_CONTACT, vapid_public_key: env.VAPID_PUBLIC_KEY || null };
  }, { auth: "user" });

  r.patch("/me", async (ctx) => {
    const b = await ctx.body(z.object({ display_name: z.string().trim().min(1).max(80).optional(), locale: z.enum(["en-IN", "hi-IN"]).optional() }));
    await ctx.q("UPDATE app_user SET display_name = coalesce($2, display_name), locale = coalesce($3, locale), updated_at = now() WHERE id = $1", [ctx.session!.userId, b.display_name ?? null, b.locale ?? null]);
    await audit(ctx, "USER_UPDATE", { table: "app_user", id: ctx.session!.userId });
    return { ok: true };
  }, { auth: "user" });

  r.post("/me/registration", async (ctx) => {
    const b = await ctx.body(z.object({
      display_name: z.string().trim().min(1).max(80),
      guardian_attestation: z.literal(true, { message: "You must confirm you are the parent or lawful guardian" }),
      adult_attestation: z.literal(true, { message: "You must confirm you are 18 or older" }),
      consents: z.object({ CORE_PROCESSING: z.literal(true, { message: "Core processing consent is required to use the app" }), ANALYTICS: z.boolean().default(false), SMS_REMINDERS: z.boolean().default(false), EMAIL_REMINDERS: z.boolean().default(false) }),
      notice_version: z.string().min(1),
      household_name: z.string().trim().min(1).max(80).optional(),
      timezone: z.string().optional(),
    }));
    if (b.notice_version !== env.PRIVACY_NOTICE_VERSION) throw new ApiError(409, "NOTICE_OUTDATED", "The privacy notice has changed — please review it again");
    const tz = b.timezone && isValidIanaZone(b.timezone) ? b.timezone : "Asia/Kolkata";
    const uid = ctx.session!.userId;
    await ctx.q(`UPDATE app_user SET display_name = $2, guardian_attested_at = now(), adult_verified_at = coalesce(adult_verified_at, now()),
                   adult_verification_method = coalesce(adult_verification_method, 'SELF_ATTESTATION'), updated_at = now() WHERE id = $1`, [uid, b.display_name]);
    for (const [purpose, granted] of Object.entries(b.consents)) {
      await ctx.q("INSERT INTO consent_record(id, user_id, purpose, notice_version, granted, method) VALUES ($1,$2,$3,$4,$5,'IN_APP_TOGGLE')", [uuidv7(), uid, purpose, b.notice_version, granted]);
    }
    const hh = await ctx.q.one("SELECT household_id FROM household_member WHERE user_id = $1 AND left_at IS NULL LIMIT 1", [uid]);
    if (!hh) {
      const hid = uuidv7();
      await ctx.q("INSERT INTO household(id, name, timezone, created_by) VALUES ($1,$2,$3,$4)", [hid, b.household_name ?? `${b.display_name}'s family`, tz, uid]);
      await ctx.q("INSERT INTO household_member(household_id, user_id, is_owner) VALUES ($1,$2,true)", [hid, uid]);
    }
    await audit(ctx, "REGISTRATION_COMPLETED", { table: "app_user", id: uid, detail: { consents: b.consents, notice_version: b.notice_version, adult_verification: "SELF_ATTESTATION" } });
    return { registration_complete: true };
  }, { auth: "user" });

  r.get("/me/settings", async (ctx) => {
    const u = await ctx.q.one<{ settings: Record<string, unknown> }>("SELECT settings FROM app_user WHERE id = $1", [ctx.session!.userId]);
    const h = await ctx.q.one<{ id: string; timezone: string }>("SELECT h.id, h.timezone FROM household h JOIN household_member hm ON hm.household_id = h.id WHERE hm.user_id = $1 AND hm.left_at IS NULL LIMIT 1", [ctx.session!.userId]);
    return { volume_unit: "ML", weight_unit: "KG", quiet_hours: { start: "22:00", end: "07:00" }, lockscreen_privacy: "SHOW_NAME", theme: "SYSTEM", ...u?.settings, household_timezone: h?.timezone ?? "Asia/Kolkata", household_id: h?.id ?? null };
  });

  r.patch("/me/settings", async (ctx) => {
    const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
    const b = await ctx.body(z.object({
      volume_unit: z.enum(["ML", "OZ"]).optional(), weight_unit: z.enum(["KG", "LB"]).optional(),
      quiet_hours: z.object({ start: hhmm, end: hhmm }).optional(), lockscreen_privacy: z.enum(["SHOW_NAME", "HIDE_NAME"]).optional(),
      theme: z.enum(["LIGHT", "DARK", "SYSTEM"]).optional(), household_timezone: z.string().optional(),
    }));
    const { household_timezone, ...rest } = b;
    await ctx.q("UPDATE app_user SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1", [ctx.session!.userId, JSON.stringify(rest)]);
    if (household_timezone) {
      if (!isValidIanaZone(household_timezone)) throw badRequest("Unknown timezone");
      const h = await ctx.q.one<{ household_id: string; is_owner: boolean }>("SELECT household_id, is_owner FROM household_member WHERE user_id = $1 AND left_at IS NULL LIMIT 1", [ctx.session!.userId]);
      if (!h?.is_owner) throw new ApiError(403, "FORBIDDEN_ROLE", "Only the household owner can change its timezone");
      await ctx.q("UPDATE household SET timezone = $2, updated_at = now() WHERE id = $1", [h.household_id, household_timezone]);
      // Recompute local dates so summaries follow the new household day boundary (spec T-TZ-02)
      await ctx.q(`UPDATE feeding f SET local_date = (f.occurred_at AT TIME ZONE $2)::date FROM baby b WHERE b.id = f.baby_id AND b.household_id = $1`, [h.household_id, household_timezone]);
      await ctx.q(`UPDATE weight_measurement w SET local_date = (w.measured_at AT TIME ZONE $2)::date FROM baby b WHERE b.id = w.baby_id AND b.household_id = $1`, [h.household_id, household_timezone]);
      await audit(ctx, "HOUSEHOLD_TIMEZONE_CHANGED", { table: "household", id: h.household_id, detail: { timezone: household_timezone } });
    }
    return { ok: true };
  });

  r.get("/me/consents", async (ctx) => ctx.q("SELECT purpose, notice_version, granted, method, recorded_at FROM consent_record WHERE user_id = $1 ORDER BY recorded_at DESC", [ctx.session!.userId]), { auth: "user" });
  r.post("/me/consents", async (ctx) => {
    const b = await ctx.body(z.object({ purpose: z.enum(["CORE_PROCESSING", "ANALYTICS", "SMS_REMINDERS", "EMAIL_REMINDERS"]), granted: z.boolean() }));
    await ctx.q("INSERT INTO consent_record(id, user_id, purpose, notice_version, granted, method) VALUES ($1,$2,$3,$4,$5,'IN_APP_TOGGLE')", [uuidv7(), ctx.session!.userId, b.purpose, env.PRIVACY_NOTICE_VERSION, b.granted]);
    await audit(ctx, b.granted ? "CONSENT_GRANTED" : "CONSENT_WITHDRAWN", { table: "consent_record", detail: { purpose: b.purpose } });
    return { ok: true, note: b.purpose === "CORE_PROCESSING" && !b.granted ? "Core processing consent withdrawn. You can export your data, then request account deletion." : undefined };
  }, { auth: "user" });

  r.get("/sessions", async (ctx) => {
    const rows = await ctx.q<{ id: string }>("SELECT id, device_name, user_agent, created_at, last_seen_at FROM user_session WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen_at DESC", [ctx.session!.userId]);
    return rows.map((r) => ({ ...r, current: r.id === ctx.session!.sessionId }));
  }, { auth: "user" });
  r.delete("/sessions/:id", async (ctx) => {
    const rows = await ctx.q("UPDATE user_session SET revoked_at = now(), revoked_reason = 'USER_REVOKED' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id", [ctx.params.id, ctx.session!.userId]);
    if (!rows.length) throw notFound("Session");
    await audit(ctx, "SESSION_REVOKED", { table: "user_session", id: ctx.params.id });
    return null;
  }, { auth: "user" });

  r.post("/me/deletion-requests", async (ctx) => {
    requireStepUp(ctx);
    const b = await ctx.body(z.object({ target_type: z.enum(["ACCOUNT", "BABY"]), target_id: z.string().uuid(), confirmation_text: z.string() }));
    if (b.target_type === "ACCOUNT") {
      if (b.target_id !== ctx.session!.userId) throw badRequest("target_id must be your user id");
      if (b.confirmation_text.trim().toUpperCase() !== "DELETE MY ACCOUNT") throw badRequest("Type DELETE MY ACCOUNT to confirm");
      const owned = await ctx.q<{ baby_id: string }>(`SELECT m.baby_id FROM baby_membership m WHERE m.user_id = $1 AND m.role = 'OWNER' AND m.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM baby_membership o WHERE o.baby_id = m.baby_id AND o.role = 'OWNER' AND o.user_id <> $1 AND o.revoked_at IS NULL)`, [ctx.session!.userId]);
      const id = uuidv7();
      await ctx.q("INSERT INTO deletion_request(id, requested_by, target_type, target_id, purge_after) VALUES ($1,$2,'ACCOUNT',$3, now() + interval '30 days')", [id, ctx.session!.userId, b.target_id]);
      for (const o of owned) await ctx.q("INSERT INTO deletion_request(id, requested_by, target_type, target_id, purge_after) VALUES ($1,$2,'BABY',$3, now() + interval '30 days')", [uuidv7(), ctx.session!.userId, o.baby_id]);
      await ctx.q("UPDATE app_user SET status = 'PENDING_DELETION' WHERE id = $1", [ctx.session!.userId]);
      await ctx.q("UPDATE user_session SET revoked_at = now(), revoked_reason = 'ACCOUNT_DELETION' WHERE user_id = $1 AND revoked_at IS NULL", [ctx.session!.userId]);
      await audit(ctx, "DELETION_REQUESTED", { table: "app_user", id: ctx.session!.userId, detail: { babies_with_sole_owner: owned.length } });
      ctx.setCookies.push(clearSessionCookie());
      return new Response(JSON.stringify({ id, purge_after_days: 30, note: "Contact support within 30 days to cancel." }), { status: 202, headers: { "Content-Type": "application/json" } });
    }
    const m = await ctx.q.one<{ role: string }>("SELECT role FROM baby_membership WHERE baby_id = $1 AND user_id = $2 AND revoked_at IS NULL", [b.target_id, ctx.session!.userId]);
    if (!m) throw notFound("Baby");
    if (m.role !== "OWNER") throw new ApiError(403, "FORBIDDEN_ROLE", "Only an owner can delete a baby's records");
    const baby = await ctx.q.one<{ first_name: string }>("SELECT first_name FROM baby WHERE id = $1", [b.target_id]);
    if (b.confirmation_text.trim() !== baby?.first_name) throw badRequest("Type the baby's first name to confirm");
    const id = uuidv7();
    await ctx.q("INSERT INTO deletion_request(id, requested_by, target_type, target_id, purge_after) VALUES ($1,$2,'BABY',$3, now() + interval '30 days')", [id, ctx.session!.userId, b.target_id]);
    await ctx.q("UPDATE baby SET deleted_at = now(), deleted_by = $2 WHERE id = $1", [b.target_id, ctx.session!.userId]);
    await audit(ctx, "BABY_DELETION_REQUESTED", { babyId: b.target_id, table: "baby", id: b.target_id });
    return new Response(JSON.stringify({ id, purge_after_days: 30 }), { status: 202, headers: { "Content-Type": "application/json" } });
  }, { auth: "user" });

  r.post("/me/deletion-requests/:id/cancel", async (ctx) => {
    const rows = await ctx.q<{ target_type: string; target_id: string }>("UPDATE deletion_request SET cancelled_at = now() WHERE id = $1 AND requested_by = $2 AND completed_at IS NULL AND cancelled_at IS NULL RETURNING target_type, target_id", [ctx.params.id, ctx.session!.userId]);
    if (!rows.length) throw notFound("Deletion request");
    if (rows[0].target_type === "BABY") await ctx.q("UPDATE baby SET deleted_at = NULL, deleted_by = NULL WHERE id = $1", [rows[0].target_id]);
    await audit(ctx, "DELETION_CANCELLED", { table: "deletion_request", id: ctx.params.id });
    return { ok: true };
  });
}
