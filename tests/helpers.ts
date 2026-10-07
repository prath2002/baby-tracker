import { apiRouter } from "@/server/api";
import { devOutbox } from "@/server/delivery";
import { pool } from "@/server/db";

export const BASE = "http://localhost:3000";

export async function resetDb() {
  await pool.query(`TRUNCATE audit_log, notification, push_subscription, share_link, export_job, deletion_request, idempotency_key, timeline_event, custom_event,
    medicine_dose, medicine_schedule, prescription_item, medicine, prescription, vaccination, appointment, allergy, feeding, feeding_plan, excretion, weight_measurement,
    baby_schedule_selection, medical_document, invitation, baby_membership, baby_household_index, baby_profile, baby, doctor, clinic, household_member, household,
    consent_record, user_session, user_password, auth_challenge, rate_limit, app_user CASCADE`);
  await pool.query("UPDATE reference_rule SET release_gate = payload->>'release_gate' WHERE payload ? 'release_gate'");
  devOutbox.length = 0;
}

export type Client = { cookie: string; userId: string; email: string; call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any; headers: Headers }> };

export async function raw(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const req = new Request(BASE + "/api/v1" + path, {
    method, headers: { "content-type": "application/json", "x-forwarded-for": headers["x-forwarded-for"] ?? `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await apiRouter().handle(req, "/api/v1");
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}

export async function login(email: string, opts: { register?: boolean } = { register: true }): Promise<Client> {
  const r1 = await raw("POST", "/auth/otp/request", { email });
  if (r1.status !== 202) throw new Error("otp request failed " + JSON.stringify(r1.body));
  const msg = [...devOutbox].reverse().find((m) => m.to === email)!;
  const code = msg.text.match(/(\d{6})/)![1];
  const r2 = await raw("POST", "/auth/otp/verify", { challenge_id: r1.body.challenge_id, code });
  if (r2.status !== 201 && r2.status !== 200) throw new Error("verify failed " + JSON.stringify(r2.body));
  const cookie = r2.headers.get("set-cookie")!.split(";")[0];
  const c: Client = {
    cookie, userId: r2.body.user_id, email,
    call: (method, path, body, headers = {}) => raw(method, path, body, { cookie: c.cookie, ...headers }),
  };
  if (opts.register && !r2.body.registration_complete) {
    const me = await c.call("GET", "/me");
    const r3 = await c.call("POST", "/me/registration", {
      display_name: email.split("@")[0], guardian_attestation: true, adult_attestation: true,
      consents: { CORE_PROCESSING: true, ANALYTICS: false, SMS_REMINDERS: false }, notice_version: me.body.privacy_notice_version, timezone: "Asia/Kolkata",
    });
    if (r3.status !== 201) throw new Error("registration failed " + JSON.stringify(r3.body));
  }
  return c;
}

export async function stepUp(c: Client) {
  const r1 = await c.call("POST", "/auth/otp/request", { email: c.email, purpose: "STEP_UP" });
  await pool.query("UPDATE auth_challenge SET created_at = created_at - interval '1 minute' WHERE identifier = $1", [c.email]);
  const code = [...devOutbox].reverse().find((m) => m.to === c.email)!.text.match(/(\d{6})/)![1];
  const r2 = await c.call("POST", "/auth/otp/verify", { challenge_id: r1.body.challenge_id, code });
  if (r2.body?.step_up !== true) throw new Error("step-up failed " + JSON.stringify(r2.body) + JSON.stringify(r1.body));
}

export async function addBaby(c: Client, body: Record<string, unknown> = {}) {
  const r = await c.call("POST", "/babies", { first_name: "Aarav", sex: "MALE", birth_date: "2026-06-27", ...body });
  if (r.status !== 201) throw new Error("add baby failed " + JSON.stringify(r.body));
  return r.body;
}

export async function clearAll(prefix = "") {
  await pool.query(`UPDATE reference_rule SET release_gate = 'CLEARED' WHERE id LIKE $1 || '%'`, [prefix]);
}
