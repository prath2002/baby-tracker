import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resetDb, login, addBaby, raw, stepUp, clearAll, type Client } from "./helpers";
import { pool, withUser, withSystem } from "@/server/db";

let alice: Client, bob: Client, carol: Client;

beforeAll(async () => {
  await resetDb();
  alice = await login("alice@example.in");
  bob = await login("bob@example.in");
  carol = await login("carol@example.in");
});
afterAll(async () => { await pool.end(); });

describe("auth & registration", () => {
  it("unauthenticated requests are rejected", async () => {
    expect((await raw("GET", "/babies")).status).toBe(401);
  });
  it("wrong OTP decrements attempts and never logs in", async () => {
    const r1 = await raw("POST", "/auth/otp/request", { email: "mallory@example.in" });
    const r2 = await raw("POST", "/auth/otp/verify", { challenge_id: r1.body.challenge_id, code: "000000" });
    expect([400]).toContain(r2.status);
    expect(r2.body.code).toBe("CODE_INCORRECT");
  });
  it("registration is required before using baby endpoints", async () => {
    const u = await login("newbie@example.in", { register: false });
    const r = await u.call("GET", "/babies");
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("REGISTRATION_INCOMPLETE");
  });
  it("cross-site POST is blocked (CSRF origin check)", async () => {
    const r = await alice.call("POST", "/babies", { first_name: "X", sex: "MALE", birth_date: "2026-01-01" }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("CSRF_ORIGIN_MISMATCH");
  });
});

describe("babies, age and wrong-baby prevention", () => {
  let twinA: any, twinB: any;
  it("creates a baby with exact age", async () => {
    twinA = await addBaby(alice, { first_name: "Aarav", birth_weight_kg: 3.1, ga_weeks: 39 });
    expect(twinA.age.totalDays).toBeGreaterThan(90);
    expect(twinA.my_role).toBe("OWNER");
    expect(twinA.categories).toEqual([]);
  });
  it("rejects future and impossible birth dates", async () => {
    expect((await alice.call("POST", "/babies", { first_name: "F", sex: "MALE", birth_date: "2099-01-01" })).status).toBe(400);
    expect((await alice.call("POST", "/babies", { first_name: "F", sex: "MALE", birth_date: "2025-02-29" })).status).toBe(400);
  });
  it("same DOB + similar name requires a distinguishing nickname", async () => {
    const r = await alice.call("POST", "/babies", { first_name: "aarav", sex: "MALE", birth_date: "2026-06-27" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("DUPLICATE_SUSPECTED");
  });
  it("twins get distinct colours", async () => {
    twinB = await addBaby(alice, { first_name: "Anaya", sex: "FEMALE", birth_weight_kg: 2.2, ga_weeks: 35 });
    expect(twinB.colour_token).not.toBe(twinA.colour_token);
    expect(twinB.categories).toEqual(expect.arrayContaining(["PRETERM_LT_37W", "LOW_BIRTH_WEIGHT_LT_2500G"]));
  });
  it("another user cannot see the baby (404, not 403)", async () => {
    expect((await bob.call("GET", `/babies/${twinA.id}`)).status).toBe(404);
    expect((await bob.call("GET", `/babies/${twinA.id}/feedings`)).status).toBe(404);
    expect((await bob.call("GET", "/babies")).body.data).toHaveLength(0);
  });
  it("RLS isolates rows even when the API layer is bypassed", async () => {
    await alice.call("POST", `/babies/${twinA.id}/feedings`, { occurred_at: new Date().toISOString(), feeding_type: "FORMULA", quantity_ml: 60 });
    const rows = await withUser(bob.userId, (q) => q("SELECT * FROM feeding"));
    expect(rows).toHaveLength(0);
    const babies = await withUser(bob.userId, (q) => q("SELECT * FROM baby"));
    expect(babies).toHaveLength(0);
    await expect(withUser(bob.userId, (q) => q("INSERT INTO feeding(id, baby_id, occurred_at, occurred_tz, local_date, feeding_type, quantity_ml, created_by) VALUES (gen_random_uuid(), $1, now(), 'UTC', current_date, 'FORMULA', 10, $2)", [twinA.id, bob.userId]))).rejects.toThrow(/row-level security/);
  });

  it("moves a feed to the correct twin, audited", async () => {
    const f = await alice.call("POST", `/babies/${twinA.id}/feedings`, { occurred_at: new Date(Date.now() - 3600_000).toISOString(), feeding_type: "EXPRESSED_BREASTMILK", quantity_ml: 70 });
    const m = await alice.call("POST", `/babies/${twinA.id}/feedings/${f.body.id}/move`, { target_baby_id: twinB.id }, { "if-match": String(f.body.version) });
    expect(m.status).toBe(201);
    expect(m.body.baby_id).toBe(twinB.id);
    expect(m.body.moved_from_baby_id).toBe(twinA.id);
    const audit = await alice.call("GET", `/audit?baby_id=${twinA.id}`);
    expect(audit.body.data.some((x: any) => x.action === "FEEDING_MOVED")).toBe(true);
    expect(audit.body.chain_intact).toBe(true);
  });
});

describe("feeding records & milk math", () => {
  let baby: any;
  const today = (h: number) => { const d = new Date(); d.setUTCHours(h - 5, 30, 0, 0); return d; }; // h:00 IST today
  beforeAll(async () => { baby = await addBaby(alice, { first_name: "Meera", sex: "FEMALE", birth_date: "2026-05-01", birth_weight_kg: 3.0, ga_weeks: 40 }); });

  it("direct breastfeeding rejects a volume (422) and stores null", async () => {
    const bad = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: today(6).toISOString(), feeding_type: "DIRECT_BREASTFEEDING", quantity_ml: 80 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe("BREASTFEEDING_VOLUME_NOT_ALLOWED");
    const ok = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: today(6).toISOString(), feeding_type: "DIRECT_BREASTFEEDING", breast_side: "LEFT", duration_minutes: 12 });
    expect(ok.status).toBe(201);
    expect(ok.body.quantity_ml).toBeNull();
  });
  it("expressed milk requires a quantity", async () => {
    const r = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: today(7).toISOString(), feeding_type: "EXPRESSED_BREASTMILK" });
    expect(r.status).toBe(400);
  });
  it("brief example: 90+100+120+100 = 410 ml and BF not converted", async () => {
    for (const [h, ml] of [[8, 90], [11, 100], [14, 120], [17, 100]]) {
      if (today(h).getTime() > Date.now()) continue;
      const r = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: today(h).toISOString(), feeding_type: "EXPRESSED_BREASTMILK", quantity_ml: ml });
      expect(r.status).toBe(201);
    }
    const s = await alice.call("GET", `/babies/${baby.id}/feedings/summary`);
    const expected = [[8, 90], [11, 100], [14, 120], [17, 100]].filter(([h]) => today(h).getTime() <= Date.now()).reduce((a, [, ml]) => a + ml, 0);
    if (expected) {
      expect(s.body.measuredMl).toBe(expected);
      expect(s.body.messages).toContain("Additional direct breastfeeding sessions were recorded but not converted to volume.");
    }
    expect(s.body.directBreastfeedingSessions).toBe(1);
    expect(JSON.stringify(s.body)).not.toMatch(/should drink|required milk/i);
  });
  it("oz entry is converted and retained", async () => {
    const r = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: new Date(Date.now() - 86400_000).toISOString(), feeding_type: "FORMULA", quantity_oz: 3 });
    expect(r.body.quantity_ml).toBe(88.7);
    expect(r.body.entered_unit).toBe("OZ");
  });
  it("duplicate detection then force", async () => {
    const t = new Date(Date.now() - 2 * 86400_000).toISOString();
    await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: t, feeding_type: "FORMULA", quantity_ml: 50 });
    const dup = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: t, feeding_type: "FORMULA", quantity_ml: 50 });
    expect(dup.status).toBe(409);
    const forced = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: t, feeding_type: "FORMULA", quantity_ml: 50, force: true });
    expect(forced.status).toBe(201);
  });
  it("idempotency key replays the same result (offline sync)", async () => {
    const body = { occurred_at: new Date(Date.now() - 3 * 86400_000).toISOString(), feeding_type: "FORMULA", quantity_ml: 40, client_id: "c-123" };
    const a = await alice.call("POST", `/babies/${baby.id}/feedings`, body, { "idempotency-key": "idem-key-0001" });
    const b = await alice.call("POST", `/babies/${baby.id}/feedings`, body, { "idempotency-key": "idem-key-0001" });
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get("idempotent-replay")).toBe("true");
  });
  it("edit requires If-Match; stale version -> 412", async () => {
    const f = await alice.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: new Date(Date.now() - 4 * 86400_000).toISOString(), feeding_type: "FORMULA", quantity_ml: 90 });
    expect((await alice.call("PATCH", `/babies/${baby.id}/feedings/${f.body.id}`, { quantity_ml: 100 })).status).toBe(428);
    const ok = await alice.call("PATCH", `/babies/${baby.id}/feedings/${f.body.id}`, { quantity_ml: 100 }, { "if-match": "1" });
    expect(ok.body.quantity_ml).toBe(100);
    expect((await alice.call("PATCH", `/babies/${baby.id}/feedings/${f.body.id}`, { quantity_ml: 110 }, { "if-match": "1" })).status).toBe(412);
    const del = await alice.call("DELETE", `/babies/${baby.id}/feedings/${f.body.id}`);
    expect(del.status).toBe(204);
    const restore = await alice.call("POST", `/babies/${baby.id}/feedings/${f.body.id}/restore`);
    expect(restore.status).toBe(201);
  });
  it("NO_DATA on an empty day, never 'low'", async () => {
    const s = await alice.call("GET", `/babies/${baby.id}/feedings/summary?date=2026-05-02`);
    expect(s.body.dataStatus).toBe("NO_DATA");
    expect(s.body.measuredMl).toBeNull();
    expect(JSON.stringify(s.body)).not.toMatch(/\blow\b/i);
  });
});

describe("reference engine gating", () => {
  let lbw: any;
  beforeAll(async () => { const d = new Date(); d.setDate(d.getDate() - 2); lbw = await addBaby(alice, { first_name: "Kabir", birth_date: d.toISOString().slice(0, 10), birth_weight_kg: 1.4, ga_weeks: 31, show_clinical_references: true }); });

  it("healthy term baby: NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND, no numbers", async () => {
    const babies = (await alice.call("GET", "/babies")).body.data;
    const term = babies.find((b: any) => b.first_name === "Meera");
    const r = await alice.call("GET", `/babies/${term.id}/references/applicable?method=DIRECT_BREASTFEEDING`);
    expect(r.body.reference_status).toBe("NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND");
    expect(r.body.rules).toHaveLength(0);
    expect(r.body.guidance).toHaveLength(0); // WHO guidance not yet cleared
    expect(r.body.pending_review).toContain("FG_WHO_RESPONSIVE");
  });
  it("LBW baby with blocked rules: NOT_ESTABLISHED (no clinical numbers shown)", async () => {
    const r = await alice.call("GET", `/babies/${lbw.id}/references/applicable`);
    expect(r.body.reference_status).toBe("NOT_ESTABLISHED");
    expect(r.body.rules).toHaveLength(0);
    expect(r.body.pending_review.some((x: string) => x.startsWith("CFR_NHM_FLUID_D3"))).toBe(true);
  });
  it("after clinical release: shows 'Clinical reference' for day-of-life 3, < 1500 g, never a personal ml target", async () => {
    await clearAll("CFR_NHM_FLUID_");
    const r = await alice.call("GET", `/babies/${lbw.id}/references/applicable`);
    expect(r.body.reference_status).toBe("CLINICAL_REFERENCE");
    expect(r.body.rules).toHaveLength(1);
    expect(r.body.rules[0]).toMatchObject({ rule_id: "CFR_NHM_FLUID_D3_LT_1500G", label: "Clinical reference", value_target: 110, unit: "ml/kg/day" });
    expect(r.body.rules[0].warnings.join(" ")).toMatch(/care team/);
    expect(JSON.stringify(r.body)).not.toMatch(/"ml\/day"|required milk/i);
  });
  it("trophic (<1200 g) and WHO A.8 are never shown in parent mode", async () => {
    await clearAll("CFR_");
    const r = await alice.call("GET", `/babies/${lbw.id}/references/applicable`);
    expect(r.body.rules.map((x: any) => x.rule_id)).not.toContain("CFR_WHO2022_A8_ADVANCE");
    expect(r.body.rules.map((x: any) => x.rule_id)).not.toContain("CFR_NHM_TROPHIC_LT1200");
  });
  it("care-team plan takes precedence", async () => {
    await alice.call("POST", `/babies/${lbw.id}/feeding-plans`, { entered_from: "DISCHARGE_SUMMARY", clinician_name: "Dr Rao", instructed_on: "2026-10-01", plan_text: "EBM 20 ml every 2 hours", volume_ml_per_feed: 20, feeds_per_day: 12, valid_from: "2026-10-01" });
    const r = await alice.call("GET", `/babies/${lbw.id}/references/applicable`);
    expect(r.body.reference_status).toBe("CARE_TEAM_PLAN");
    expect(r.body.plan.clinician_name).toBe("Dr Rao");
  });
});

describe("roles: caregiver, viewer and documents", () => {
  let baby: any;
  beforeAll(async () => {
    baby = await addBaby(alice, { first_name: "Ira", sex: "FEMALE", birth_date: "2026-03-10" });
    const inv = await alice.call("POST", `/babies/${baby.id}/members`, { email: "bob@example.in", role: "CAREGIVER" });
    const token = inv.body.invite_link.split("/invite/")[1];
    expect((await bob.call("POST", "/invitations/accept", { token })).status).toBe(201);
    const inv2 = await alice.call("POST", `/babies/${baby.id}/members`, { email: "carol@example.in", role: "VIEWER" });
    expect((await carol.call("POST", "/invitations/accept", { token: inv2.body.invite_link.split("/invite/")[1] })).status).toBe(201);
  });
  it("caregiver can log feeds but not vaccines or allergies", async () => {
    expect((await bob.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: new Date().toISOString(), feeding_type: "DIRECT_BREASTFEEDING" })).status).toBe(201);
    expect((await bob.call("POST", `/babies/${baby.id}/vaccinations`, { vaccine_name_as_recorded: "BCG", given_on: "2026-03-10" })).status).toBe(403);
    expect((await bob.call("POST", `/babies/${baby.id}/allergies`, { substance: "Egg", status: "SUSPECTED" })).status).toBe(403);
  });
  it("caregiver without document permission cannot list documents", async () => {
    expect((await bob.call("GET", `/babies/${baby.id}/documents`)).status).toBe(403);
  });
  it("viewer is read-only", async () => {
    expect((await carol.call("GET", `/babies/${baby.id}/feedings`)).status).toBe(200);
    expect((await carol.call("POST", `/babies/${baby.id}/feedings`, { occurred_at: new Date().toISOString(), feeding_type: "DIRECT_BREASTFEEDING" })).status).toBe(403);
  });
  it("only owners change roles (with step-up)", async () => {
    expect((await bob.call("PATCH", `/babies/${baby.id}/members/${carol.userId}`, { role: "GUARDIAN" })).status).toBe(403);
    await withSystem((q) => q("UPDATE user_session SET step_up_at = now() - interval '1 hour' WHERE user_id = $1", [alice.userId]));
    expect((await alice.call("PATCH", `/babies/${baby.id}/members/${carol.userId}`, { role: "GUARDIAN" })).body.code).toBe("STEP_UP_REQUIRED");
    await stepUp(alice);
    expect((await alice.call("PATCH", `/babies/${baby.id}/members/${carol.userId}`, { role: "GUARDIAN" })).status).toBe(200);
  });
  it("cannot remove the last owner", async () => {
    expect((await alice.call("DELETE", `/babies/${baby.id}/members/${alice.userId}`)).status).toBe(422);
  });
});

describe("documents: upload validation and scanning", () => {
  let baby: any;
  beforeAll(async () => { baby = (await alice.call("GET", "/babies")).body.data.find((b: any) => b.first_name === "Meera"); });
  async function upload(bytes: Buffer, declared: string, title = "Report") {
    const intent = await alice.call("POST", `/babies/${baby.id}/documents/upload-intents`, { title, doc_type: "LAB_REPORT", file_name: "x", declared_mime: declared, size_bytes: bytes.length });
    expect(intent.status).toBe(201);
    const { PUT } = await import("@/app/api/files/local/route");
    const put = await PUT(new Request(intent.body.upload_url, { method: "PUT", headers: { "content-type": declared }, body: new Uint8Array(bytes) }));
    expect(put.status).toBe(200);
    return alice.call("POST", `/babies/${baby.id}/documents/${intent.body.document_id}/complete`);
  }
  it("accepts a clean PDF and issues a short-lived signed URL", async () => {
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const r = await upload(pdf, "application/pdf");
    expect(r.body.scan_status).toBe("CLEAN");
    const v = await alice.call("POST", `/babies/${baby.id}/documents/${r.body.id}/view-url`, {});
    expect(v.status).toBe(201);
    expect(new Date(v.body.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(300_000);
    expect((await bob.call("POST", `/babies/${baby.id}/documents/${r.body.id}/view-url`, {})).status).toBe(404);
  });
  it("rejects a spoofed type (PNG bytes declared as PDF)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const r = await upload(png, "application/pdf");
    expect(r.body.scan_status).toBe("REJECTED");
  });
  it("rejects PDFs with JavaScript", async () => {
    const r = await upload(Buffer.from("%PDF-1.4\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert(1))>>>>endobj"), "application/pdf");
    expect(r.body.scan_status).toBe("REJECTED");
  });
  it("blocks EICAR test file as infected", async () => {
    const eicar = Buffer.from("%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    const r = await upload(eicar, "application/pdf");
    expect(r.body.scan_status).toBe("INFECTED");
    expect((await alice.call("POST", `/babies/${baby.id}/documents/${r.body.id}/view-url`, {})).status).toBe(409);
  });
});

describe("growth, vaccines, summaries, exports", () => {
  let baby: any;
  beforeAll(async () => { baby = (await alice.call("GET", "/babies")).body.data.find((b: any) => b.first_name === "Meera"); });
  it("weight tracking with change per day", async () => {
    await alice.call("POST", `/babies/${baby.id}/measurements`, { measured_at: "2026-09-01T10:00:00+05:30", weight_kg: 4.5, measurement_source: "CLINIC" });
    const r = await alice.call("POST", `/babies/${baby.id}/measurements`, { measured_at: "2026-09-11T10:00:00+05:30", weight_kg: 4.8, measurement_source: "HOME_SCALE" });
    expect(r.status).toBe(201);
    const list = await alice.call("GET", `/babies/${baby.id}/measurements`);
    const latest = list.body.data[0];
    expect(latest.change_since_previous_g).toBe(300);
    expect(latest.g_per_day).toBe(30);
  });
  it("growth reference unavailable until the WHO dataset is imported (never approximated)", async () => {
    const g = await alice.call("GET", `/babies/${baby.id}/growth?indicator=WEIGHT_FOR_AGE`);
    expect(g.body.status).toBe("DATASET_NOT_IMPORTED");
    expect(g.body.points).toHaveLength(0);
  });
  it("vaccine plan blocked until released; manual recording still works", async () => {
    const p = await alice.call("GET", `/babies/${baby.id}/vaccinations/plan`);
    expect(p.status).toBe(409);
    expect((await alice.call("POST", `/babies/${baby.id}/vaccinations`, { vaccine_code: "BCG", vaccine_name_as_recorded: "BCG", given_on: "2026-05-01" })).status).toBe(201);
    await clearAll("UIP_");
    const p2 = await alice.call("GET", `/babies/${baby.id}/vaccinations/plan`);
    expect(p2.status).toBe(200);
    expect(p2.body.items.find((i: any) => i.code === "BCG").status).toBe("GIVEN");
    expect(p2.body.items.find((i: any) => i.code === "FIPV_3")).toBeTruthy(); // DOB 2026 => 2023 amendment applies
    expect(p2.body.items.find((i: any) => i.code === "JE_1").status).toBe("NOT_APPLICABLE");
  });
  it("weekly summary separates NO_DATA days and states the denominator", async () => {
    const w = await alice.call("GET", `/babies/${baby.id}/summaries/weekly?rolling=true`);
    expect(w.status).toBe(200);
    expect(w.body.feeding.days).toHaveLength(7);
    expect(["NO_DATA", "PARTIAL_DATA", "RECORDED"]).toContain(w.body.feeding.dataStatus);
    expect(w.body.data_quality_notes[0]).toMatch(/of 7 days/);
  });
  it("PDF export is generated and the download link is single-use", async () => {
    const e = await alice.call("POST", "/exports", { baby_id: baby.id, format: "PDF_VISIT_SUMMARY" });
    expect(e.status).toBe(201);
    const d1 = await alice.call("POST", `/exports/${e.body.id}/download-url`);
    expect(d1.status).toBe(201);
    expect((await alice.call("POST", `/exports/${e.body.id}/download-url`)).status).toBe(410);
  });
  it("JSON export requires step-up", async () => {
    await withSystem((q) => q("UPDATE user_session SET step_up_at = now() - interval '1 hour' WHERE user_id = $1", [alice.userId]));
    expect((await alice.call("POST", "/exports", { baby_id: baby.id, format: "JSON" })).body.code).toBe("STEP_UP_REQUIRED");
  });
  it("timeline links back to source records", async () => {
    const t = await alice.call("GET", `/babies/${baby.id}/timeline`);
    expect(t.body.data.length).toBeGreaterThan(3);
    expect(t.body.data.every((e: any) => e.source_id && e.source_table)).toBe(true);
    expect(t.body.data.some((e: any) => e.event_type === "BIRTH")).toBe(true);
  });
});
