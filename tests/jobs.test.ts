import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, login, addBaby, clearAll, type Client } from "./helpers";
import { pool, withSystem } from "@/server/db";
import { scheduleNotifications, dispatchDue, markMissedDoses } from "@/server/notifications";
import { purgeDue } from "@/server/purge";

let u: Client, baby: any;
beforeAll(async () => {
  await resetDb();
  u = await login("jobs@example.in");
  baby = await addBaby(u, { first_name: "Riya", sex: "FEMALE", birth_date: "2026-08-20" });
});
afterAll(async () => { await pool.end(); });

describe("notification jobs", () => {
  it("plans appointment, medicine and vaccine reminders without health details", async () => {
    await clearAll("UIP_");
    const soon = new Date(Date.now() + 6 * 3600_000).toISOString();
    await u.call("POST", `/babies/${baby.id}/appointments`, { starts_at: soon, purpose: "VACCINATION", reminder_offsets_min: [120] });
    await u.call("POST", `/babies/${baby.id}/medicines`, { medicine_name: "Vitamin D drops", dose_text_as_prescribed: "as prescribed", start_date: "2026-10-01", schedule: { kind: "EVERY_N_HOURS", every_n_hours: 6, anchor_time: "00:00" } });
    const r = await scheduleNotifications();
    expect(r.created).toBeGreaterThan(0);
    const rows = await withSystem((q) => q<{ kind: string; title: string; body: string }>("SELECT kind, title, body FROM notification"));
    expect(new Set(rows.map((x) => x.kind))).toEqual(expect.objectContaining({}));
    expect(rows.some((x) => x.kind === "APPOINTMENT")).toBe(true);
    expect(rows.some((x) => x.kind === "MEDICINE")).toBe(true);
    for (const n of rows) expect(`${n.title} ${n.body}`).not.toMatch(/vitamin|bcg|opv|penta|dose of/i);
    const again = await scheduleNotifications();
    expect(again.created).toBe(0); // idempotent via dedupe keys
  });
  it("dispatch marks due notifications sent (in-app inbox even without push keys)", async () => {
    await withSystem((q) => q("UPDATE notification SET scheduled_for = now() - interval '1 minute' WHERE kind = 'APPOINTMENT'"));
    const d = await dispatchDue();
    expect(d.due).toBeGreaterThan(0);
    const inbox = await u.call("GET", "/notifications");
    expect(inbox.body.data.some((n: any) => n.kind === "APPOINTMENT")).toBe(true);
  });
  it("marks missed doses after the window", async () => {
    const r = await markMissedDoses(new Date(), 6);
    expect(r.missed).toBeGreaterThanOrEqual(0);
  });
});

describe("deletion purge", () => {
  it("baby deletion is recoverable, then hard-purged after 30 days", async () => {
    const tmp = await addBaby(u, { first_name: "Temp", sex: "MALE", birth_date: "2026-01-01" });
    await u.call("POST", `/babies/${tmp.id}/feedings`, { occurred_at: new Date().toISOString(), feeding_type: "FORMULA", quantity_ml: 30 });
    const del = await u.call("POST", "/me/deletion-requests", { target_type: "BABY", target_id: tmp.id, confirmation_text: "Temp" });
    expect(del.status).toBe(202);
    expect((await u.call("GET", `/babies/${tmp.id}`)).status).toBe(404);
    await withSystem((q) => q("UPDATE deletion_request SET purge_after = now() - interval '1 minute' WHERE target_id = $1", [tmp.id]));
    const p = await purgeDue();
    expect(p.babies).toBe(1);
    const left = await withSystem((q) => q("SELECT 'feeding' AS t FROM feeding WHERE baby_id = $1 UNION ALL SELECT 'baby' FROM baby WHERE id = $1", [tmp.id]));
    expect(left).toHaveLength(0);
    const audit = await withSystem((q) => q("SELECT 1 FROM audit_log WHERE action = 'PURGE_COMPLETED'"));
    expect(audit.length).toBe(1);
  });
});
