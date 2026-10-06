import "server-only";
import { DateTime } from "luxon";
import webpush from "web-push";
import { uuidv7 } from "@/lib/ids";
import { withSystem, type Q } from "./db";
import { env } from "./env";
import { buildPlan, loadScheduleItems, type ScheduleId } from "./vaccines";

/** Medicine dose slots for a local day (user-defined schedules only; the app never suggests doses). */
export async function dosesForDay(q: Q, babyId: string, localDate: string, tz: string) {
  const meds = await q<{ id: string; medicine_name: string; dose_amount: number | null; dose_unit: string | null; dose_text_as_prescribed: string | null; start_date: string; end_date: string | null;
    kind: string; times_of_day: string[] | null; every_n_hours: number | null; anchor_time: string | null; stz: string }>(
    `SELECT m.id, m.medicine_name, m.dose_amount::float, m.dose_unit, m.dose_text_as_prescribed, to_char(m.start_date,'YYYY-MM-DD') AS start_date, to_char(m.end_date,'YYYY-MM-DD') AS end_date,
            s.kind, s.times_of_day, s.every_n_hours, s.anchor_time, s.tz AS stz
     FROM medicine m JOIN medicine_schedule s ON s.medicine_id = m.id
     WHERE m.baby_id = $1 AND m.status = 'ACTIVE' AND m.deleted_at IS NULL AND m.start_date <= $2 AND (m.end_date IS NULL OR m.end_date >= $2)`, [babyId, localDate]);
  const out: { medicine_id: string; medicine_name: string; dose: string; scheduled_for: string; status: string | null; dose_id: string | null }[] = [];
  for (const m of meds) {
    const z = m.stz || tz;
    const slots: DateTime[] = [];
    if (m.kind === "TIMES_OF_DAY") for (const t of m.times_of_day ?? []) slots.push(DateTime.fromISO(`${localDate}T${t}`, { zone: z }));
    if (m.kind === "EVERY_N_HOURS" && m.every_n_hours) {
      const anchor = DateTime.fromISO(`${m.start_date}T${m.anchor_time ?? "08:00"}`, { zone: z });
      const dayStart = DateTime.fromISO(localDate, { zone: z }).startOf("day"), dayEnd = dayStart.plus({ days: 1 });
      let t = anchor;
      if (t < dayStart) t = t.plus({ hours: Math.ceil(dayStart.diff(t, "hours").hours / m.every_n_hours) * m.every_n_hours });
      for (; t < dayEnd; t = t.plus({ hours: m.every_n_hours })) if (t >= dayStart) slots.push(t);
    }
    for (const s of slots) {
      const iso = s.toUTC().toISO()!;
      const d = await q.one<{ id: string; status: string }>("SELECT id, status FROM medicine_dose WHERE medicine_id = $1 AND scheduled_for = $2 AND deleted_at IS NULL", [m.id, iso]);
      out.push({ medicine_id: m.id, medicine_name: m.medicine_name, dose: m.dose_text_as_prescribed ?? (m.dose_amount ? `${m.dose_amount} ${String(m.dose_unit ?? "").toLowerCase()}` : "as prescribed"), scheduled_for: iso, status: d?.status ?? null, dose_id: d?.id ?? null });
    }
  }
  return out.sort((a, b) => a.scheduled_for.localeCompare(b.scheduled_for));
}

function inQuietHours(at: DateTime, quiet: { start: string; end: string }) {
  const m = at.hour * 60 + at.minute;
  const [sh, sm] = quiet.start.split(":").map(Number), [eh, em] = quiet.end.split(":").map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
function shiftOutOfQuiet(at: DateTime, quiet: { start: string; end: string }) {
  if (!inQuietHours(at, quiet)) return at;
  const [eh, em] = quiet.end.split(":").map(Number);
  let t = at.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (t <= at) t = t.plus({ days: 1 });
  return t;
}

/** Plans upcoming notifications for every member of every baby, or for one user (idempotent through dedupe keys). Runs from cron and when a user opens the app. */
export async function scheduleNotifications(now = new Date(), userId: string | null = null) {
  return withSystem(async (q) => {
    let created = 0;
    const horizon = DateTime.fromJSDate(now).plus({ hours: 26 });
    const members = await q<{ user_id: string; baby_id: string; first_name: string; birth_date: string; timezone: string; settings: Record<string, unknown>; role: string }>(
      `SELECT m.user_id, m.baby_id, b.first_name, to_char(b.birth_date,'YYYY-MM-DD') AS birth_date, h.timezone, u.settings, m.role
       FROM baby_membership m JOIN baby b ON b.id = m.baby_id AND b.deleted_at IS NULL AND b.archived_at IS NULL JOIN household h ON h.id = b.household_id
       JOIN app_user u ON u.id = m.user_id AND u.status = 'ACTIVE' WHERE m.revoked_at IS NULL AND ($1::uuid IS NULL OR m.user_id = $1)`, [userId]);
    const add = async (userId: string, babyId: string, kind: string, title: string, body: string, path: string, at: DateTime, key: string, respectQuiet: boolean, quiet: { start: string; end: string }) => {
      const when = respectQuiet ? shiftOutOfQuiet(at, quiet) : at;
      const r = await q(`INSERT INTO notification(id, user_id, baby_id, kind, title, body, target_path, scheduled_for, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
        [uuidv7(), userId, babyId, kind, title, body, path, when.toUTC().toISO(), `${key}:u:${userId}`]);
      created += r.length;
    };
    for (const m of members) {
      const s = m.settings as { quiet_hours?: { start: string; end: string }; lockscreen_privacy?: string };
      const quiet = s.quiet_hours ?? { start: "22:00", end: "07:00" };
      const name = s.lockscreen_privacy === "HIDE_NAME" ? "your baby" : m.first_name;
      const zone = m.timezone;
      // Vaccines (selected schedule; only released items)
      const sel = await q.one<{ schedule_id: ScheduleId; je_opt_in: boolean }>("SELECT schedule_id, je_opt_in FROM baby_schedule_selection WHERE baby_id = $1 AND ended_at IS NULL", [m.baby_id]);
      if (sel) {
        const items = await loadScheduleItems(q, sel.schedule_id);
        const given = await q<{ id: string; vaccine_code: string | null; given_on: string }>("SELECT id, vaccine_code, to_char(given_on,'YYYY-MM-DD') AS given_on FROM vaccination WHERE baby_id = $1 AND deleted_at IS NULL", [m.baby_id]);
        const today = DateTime.fromJSDate(now).setZone(zone).toISODate()!;
        const plan = buildPlan({ scheduleId: sel.schedule_id, birthDate: m.birth_date, today, jeOptIn: sel.je_opt_in, given, items });
        for (const it of plan.items) {
          if (it.status === "GIVEN" || it.status === "NOT_APPLICABLE") continue;
          const due = DateTime.fromISO(`${it.due_from}T09:00`, { zone });
          for (const [offsetDays, tag] of [[-3, "pre3"], [0, "due"]] as const) {
            const at = due.plus({ days: offsetDays });
            if (at.toJSDate() >= now && at <= horizon) await add(m.user_id, m.baby_id, "VACCINE_DUE", `Vaccine reminder for ${name}`, `${it.dose_label} is ${offsetDays ? "coming up" : "due"} — open the app for details.`, `/babies/${m.baby_id}/vaccinations`, at, `vac:${m.baby_id}:${it.code}:${tag}`, true, quiet);
          }
        }
      }
      // Appointments
      const appts = await q<{ id: string; starts_at: Date; reminder_offsets_min: number[] }>(
        "SELECT id, starts_at, reminder_offsets_min FROM appointment WHERE baby_id = $1 AND status = 'SCHEDULED' AND deleted_at IS NULL AND starts_at BETWEEN $2 AND $3::timestamptz + interval '15 days'", [m.baby_id, now, horizon.toJSDate()]);
      for (const a of appts) for (const off of a.reminder_offsets_min) {
        const at = DateTime.fromJSDate(a.starts_at).minus({ minutes: off });
        if (at.toJSDate() >= now && at <= horizon) await add(m.user_id, m.baby_id, "APPOINTMENT", `Appointment reminder for ${name}`, `An appointment is coming up. Open the app for details.`, `/babies/${m.baby_id}/appointments/${a.id}`, at, `appt:${a.id}:${off}`, false, quiet);
      }
      // Medicines (only for roles that can record doses)
      if (["OWNER", "GUARDIAN", "CAREGIVER"].includes(m.role)) {
        for (const dd of [0, 1]) {
          const date = DateTime.fromJSDate(now).setZone(zone).plus({ days: dd }).toISODate()!;
          for (const slot of await dosesForDay(q, m.baby_id, date, zone)) {
            if (slot.status) continue;
            const at = DateTime.fromISO(slot.scheduled_for);
            const sched = await q.one<{ allow_quiet_hours: boolean; reminders_enabled: boolean }>("SELECT allow_quiet_hours, reminders_enabled FROM medicine_schedule WHERE medicine_id = $1", [slot.medicine_id]);
            if (!sched?.reminders_enabled) continue;
            if (at.toJSDate() >= now && at <= horizon) await add(m.user_id, m.baby_id, "MEDICINE", `Medicine reminder for ${name}`, `A scheduled medicine is due. Follow your doctor's instructions.`, `/babies/${m.baby_id}/medicines`, at, `med:${slot.medicine_id}:${slot.scheduled_for}`, !sched.allow_quiet_hours, quiet);
          }
        }
      }
    }
    return { created };
  });
}

/**
 * In-app reminders: plan for this user when they open the app, so medicines/appointments added since the daily cron
 * still get reminders. Throttled per user per server instance; safe to repeat because planning is idempotent.
 */
const lastPlanned = new Map<string, number>();
export async function planForUser(userId: string, everyMs = 10 * 60_000) {
  const t = lastPlanned.get(userId) ?? 0;
  if (Date.now() - t < everyMs) return;
  lastPlanned.set(userId, Date.now());
  try { await scheduleNotifications(new Date(), userId); }
  catch (e) { lastPlanned.delete(userId); console.error("[reminders] planning failed", e); }
}

/** Sends due notifications. Push payloads carry no health details — only a generic title and an in-app path. */
export async function dispatchDue(now = new Date()) {
  const pushReady = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (pushReady) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  return withSystem(async (q) => {
    const due = await q<{ id: string; user_id: string; title: string; target_path: string | null }>(
      "SELECT id, user_id, title, target_path FROM notification WHERE status = 'PENDING' AND scheduled_for <= $1 ORDER BY scheduled_for LIMIT 500 FOR UPDATE SKIP LOCKED", [now]);
    let pushed = 0;
    for (const n of due) {
      if (pushReady) {
        const subs = await q<{ id: string; endpoint: string; p256dh: string; auth: string }>("SELECT id, endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1", [n.user_id]);
        for (const s of subs) {
          try {
            await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: n.title, path: n.target_path ?? "/", id: n.id }), { TTL: 3600 });
            await q("UPDATE push_subscription SET last_success_at = now(), failure_count = 0 WHERE id = $1", [s.id]);
            pushed++;
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) await q("DELETE FROM push_subscription WHERE id = $1", [s.id]);
            else await q("UPDATE push_subscription SET failure_count = failure_count + 1 WHERE id = $1", [s.id]);
          }
        }
      }
      await q("UPDATE notification SET status = 'SENT', sent_at = now() WHERE id = $1", [n.id]); // always visible in the in-app inbox
    }
    return { due: due.length, pushed };
  });
}

/** Marks scheduled medicine doses older than the window as MISSED (spec §28). */
export async function markMissedDoses(now = new Date(), windowHours = 6) {
  return withSystem(async (q) => {
    const babies = await q<{ id: string; timezone: string }>("SELECT b.id, h.timezone FROM baby b JOIN household h ON h.id = b.household_id WHERE b.deleted_at IS NULL");
    let missed = 0;
    for (const b of babies) {
      const yesterday = DateTime.fromJSDate(now).setZone(b.timezone).minus({ days: 1 }).toISODate()!;
      const today = DateTime.fromJSDate(now).setZone(b.timezone).toISODate()!;
      for (const d of [yesterday, today]) for (const slot of await dosesForDay(q, b.id, d, b.timezone)) {
        if (slot.status || Date.parse(slot.scheduled_for) > now.getTime() - windowHours * 3600_000) continue;
        const r = await q(`INSERT INTO medicine_dose(id, medicine_id, baby_id, scheduled_for, status, created_by) SELECT $1,$2,$3,$4,'MISSED', created_by FROM medicine WHERE id = $2
                           ON CONFLICT DO NOTHING RETURNING id`, [uuidv7(), slot.medicine_id, b.id, slot.scheduled_for]);
        missed += r.length;
      }
    }
    return { missed };
  });
}
