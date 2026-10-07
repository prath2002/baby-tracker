import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { resetDb, login, addBaby, type Client } from "./helpers";
import { pool } from "@/server/db";
import { env } from "@/server/env";
import { requireNamedBaby, runTool, toolDefinitions, type AssistantContext, type Proposal } from "@/server/assistant/tools";

const A = "0190a6b2-0000-7000-8000-000000000001", B = "0190a6b2-0000-7000-8000-000000000002", MED = "0190a6b2-0000-7000-8000-0000000000aa";
const ctx = (role = "OWNER"): AssistantContext => ({
  now: new Date("2026-10-06T10:00:00Z"), tz: "Asia/Kolkata", currentBabyId: null, doctors: [], clinics: [],
  babies: [
    { id: A, name: "Aarav", nickname: null, colour: "MINT", role, birthDate: "2026-06-27", ageDisplay: "14 weeks", householdId: "h1", medicines: [{ id: MED, name: "Vitamin D3", dose: "400 iu", status: "ACTIVE" }] },
    { id: B, name: "Anaya", nickname: null, colour: "PEACH", role, birthDate: "2026-06-27", ageDisplay: "14 weeks", householdId: "h1", medicines: [] },
  ],
});
const call = (name: string, args: unknown, c = ctx()) => runTool(name, JSON.stringify(args), c);

describe("assistant tools → proposals", () => {
  it("publishes a JSON schema per tool with the baby ids as an enum", () => {
    const defs = toolDefinitions(ctx());
    expect(defs.map((d) => d.function.name)).toEqual(expect.arrayContaining(["log_feeding", "log_measurement", "log_medicine_dose", "add_medicine", "add_prescription", "add_allergy", "log_vaccination", "add_appointment", "add_feeding_plan", "add_doctor", "add_clinic", "log_other", "ask_user"]));
    const feed = defs.find((d) => d.function.name === "log_feeding")!.function.parameters as { properties: { baby_id: { enum: string[] } } };
    expect(feed.properties.baby_id.enum).toEqual([A, B]);
  });

  it("maps a feed to the feedings endpoint for the chosen baby", () => {
    const r = call("log_feeding", { baby_id: B, occurred_at: "2026-10-06T15:10:00+05:30", feeding_type: "FORMULA", quantity_ml: 60 });
    expect(r.ok && "proposal" in r).toBe(true);
    if (!r.ok || !("proposal" in r)) return;
    expect(r.proposal.baby_id).toBe(B);
    expect(r.proposal.title).toBe("Formula · 60 ml");
    expect(r.proposal.steps).toHaveLength(1);
    expect(r.proposal.steps[0].path).toBe(`/babies/${B}/feedings`);
    expect(r.proposal.steps[0].body).toMatchObject({ feeding_type: "FORMULA", quantity_ml: 60, occurred_tz: "Asia/Kolkata" });
    expect(r.proposal.steps[0].body).not.toHaveProperty("baby_id");
    expect(r.proposal.offline_ok).toBe(true);
  });

  it("rejects a baby id that is not in the user's list", () => {
    const r = call("log_feeding", { baby_id: "0190a6b2-0000-7000-8000-00000000dead", occurred_at: "2026-10-06T15:10:00+05:30", feeding_type: "FORMULA", quantity_ml: 60 });
    expect(r.ok).toBe(false);
  });

  it("rejects times without a timezone offset", () => {
    expect(call("log_feeding", { baby_id: A, occurred_at: "2026-10-06 15:10", feeding_type: "FORMULA", quantity_ml: 60 }).ok).toBe(false);
  });

  it("records a dose of a known medicine (matched by name) as a single LOG step", () => {
    const r = call("log_medicine_dose", { baby_id: A, medicine_name: "vitamin d3", given_at: "2026-10-06T09:00:00+05:30" }, ctx("CAREGIVER"));
    if (!r.ok || !("proposal" in r)) throw new Error("expected proposal");
    expect(r.proposal.steps.map((s) => s.path)).toEqual([`/babies/${A}/medicines/${MED}/doses`]);
    expect(r.proposal.blocked).toBeUndefined();
  });

  it("adds an unknown medicine first, then the dose — and blocks caregivers from creating medicines", () => {
    const owner = call("log_medicine_dose", { baby_id: B, medicine_name: "Paracetamol", dose_amount: 2.5, dose_unit: "ML" });
    if (!owner.ok || !("proposal" in owner)) throw new Error("expected proposal");
    expect(owner.proposal.steps.map((s) => s.path)).toEqual([`/babies/${B}/medicines`, `/babies/${B}/medicines/{{0.id}}/doses`]);
    expect(owner.proposal.steps[1].body.notes).toBe("Amount given: 2.5 ml");
    expect(owner.proposal.blocked).toBeUndefined();
    const carer = call("log_medicine_dose", { baby_id: B, medicine_name: "Paracetamol" }, ctx("CAREGIVER"));
    if (!carer.ok || !("proposal" in carer)) throw new Error("expected proposal");
    expect(carer.proposal.blocked).toMatch(/parent or guardian/);
  });

  it("allergies default to suspected and need MANAGE", () => {
    const r = call("add_allergy", { baby_id: A, substance: "Cow's milk", reaction_text: "rash on cheeks" }, ctx("CAREGIVER"));
    if (!r.ok || !("proposal" in r)) throw new Error("expected proposal");
    expect(r.proposal.steps[0].body).toMatchObject({ substance: "Cow's milk", status: "SUSPECTED", severity_reported: "UNKNOWN" });
    expect(r.proposal.blocked).toBeTruthy();
  });

  it("requires at least one measurement value", () => {
    expect(call("log_measurement", { baby_id: A, measured_at: "2026-10-06T09:00:00+05:30" }).ok).toBe(false);
  });

  it("maps pee/poop/vomit to the excretions endpoint, keeping the parent's description as notes", () => {
    const defs = toolDefinitions(ctx());
    const schema = defs.find((d) => d.function.name === "log_excretion")!.function.parameters as { properties: { excretion_type: { enum: string[] } } };
    expect(schema.properties.excretion_type.enum).toEqual(["URINE", "STOOL", "URINE_AND_STOOL", "VOMIT"]);
    const r = call("log_excretion", { baby_id: A, occurred_at: "2026-10-06T15:10:00+05:30", excretion_type: "STOOL", notes: "yellow, liquidy" }, ctx("CAREGIVER"));
    if (!r.ok || !("proposal" in r)) throw new Error("expected proposal");
    expect(r.proposal.title).toBe("Poop");
    expect(r.proposal.details).toContain("yellow, liquidy");
    expect(r.proposal.steps).toEqual([{ method: "POST", path: `/babies/${A}/excretions`, body: expect.objectContaining({ excretion_type: "STOOL", notes: "yellow, liquidy", occurred_tz: "Asia/Kolkata" }) }]);
    expect(r.proposal.blocked).toBeUndefined();
    expect(r.proposal.offline_ok).toBe(true);
    const both = call("log_excretion", { baby_id: B, occurred_at: "2026-10-06T15:10:00+05:30", excretion_type: "URINE_AND_STOOL" });
    if (!both.ok || !("proposal" in both)) throw new Error("expected proposal");
    expect(both.proposal.title).toBe("Pee + poop");
    expect(both.proposal.steps[0].body).not.toHaveProperty("notes");
    expect(call("log_excretion", { baby_id: A, occurred_at: "2026-10-06T15:10:00+05:30", excretion_type: "DIAPER" }).ok).toBe(false);
  });

  it("ask_user returns tap-able options", () => {
    const r = call("ask_user", { question: "For Aarav or Anaya?", options: ["Aarav", "Anaya"] });
    expect(r).toEqual({ ok: true, ask: { question: "For Aarav or Anaya?", options: ["Aarav", "Anaya"] } });
  });
});

describe("wrong-baby guard", () => {
  const feedFor = (babyId: string) => {
    const r = call("log_feeding", { baby_id: babyId, occurred_at: "2026-10-06T15:10:00+05:30", feeding_type: "FORMULA", quantity_ml: 90 });
    if (!r.ok || !("proposal" in r)) throw new Error("expected proposal");
    return r.proposal as Proposal;
  };
  it("asks who it is for when no baby is named, even from a baby's screen", () => {
    const g = requireNamedBaby([feedFor(A)], { ...ctx(), currentBabyId: B }, ["milk given 90 ml 10 minutes ago"]);
    expect(g.proposals).toHaveLength(0);
    expect(g.ask).toEqual({ question: "Who is this for?", options: ["Anaya", "Aarav", "Both"] });
  });
  it("keeps entries for the named baby, case-insensitively", () => {
    expect(requireNamedBaby([feedFor(B)], ctx(), ["milk given 90 ml", "it was for anaya"]).proposals).toHaveLength(1);
  });
  it("rejects a guess that contradicts the named baby", () => {
    const g = requireNamedBaby([feedFor(A)], ctx(), ["Anaya had 90 ml"]);
    expect(g.proposals).toHaveLength(0);
    expect(g.ask).not.toBeNull();
  });
  it("follow-up corrections keep the most recently named baby", () => {
    expect(requireNamedBaby([feedFor(B)], ctx(), ["Anaya had 90 ml", "make it 120 ml"]).proposals).toHaveLength(1);
  });
  it("'both' allows every baby; nicknames count; one baby never asks", () => {
    expect(requireNamedBaby([feedFor(A), feedFor(B)], ctx(), ["both had vitamin D"]).proposals).toHaveLength(2);
    const nick = ctx(); nick.babies[0].nickname = "Chotu";
    expect(requireNamedBaby([feedFor(A)], nick, ["chotu had 90 ml"]).proposals).toHaveLength(1);
    const one = ctx(); one.babies = [one.babies[0]];
    expect(requireNamedBaby([feedFor(A)], one, ["90 ml"]).ask).toBeNull();
  });
  it("does not match a name inside another word", () => {
    const short = ctx(); short.babies[1].name = "Ria";
    expect(requireNamedBaby([feedFor(B)], short, ["noted the criteria"]).proposals).toHaveLength(0);
  });
});

describe("assistant API (OpenRouter mocked)", () => {
  let alice: Client, baby: { id: string };
  const realFetch = globalThis.fetch;
  const llmReply = (toolCalls: { name: string; args: unknown }[], content: string | null = null) =>
    new Response(JSON.stringify({ choices: [{ message: { content, tool_calls: toolCalls.map((t, i) => ({ id: `call_${i}`, type: "function", function: { name: t.name, arguments: JSON.stringify(t.args) } })) } }] }), { status: 200 });

  beforeAll(async () => {
    await resetDb();
    alice = await login("alice@example.in");
    baby = await addBaby(alice, { first_name: "Aarav" });
    env.OPENROUTER_API_KEY = "test-key";
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  afterAll(async () => { env.OPENROUTER_API_KEY = ""; await pool.end(); });

  it("reports whether the assistant is enabled", async () => {
    expect((await alice.call("GET", "/assistant/status")).body.enabled).toBe(true);
  });

  it("turns a message into a proposal that saves through the normal endpoint", async () => {
    const at = new Date(Date.now() - 20 * 60_000).toISOString().replace("Z", "+00:00");
    const fetchMock = vi.fn().mockResolvedValue(llmReply([{ name: "log_feeding", args: { baby_id: baby.id, occurred_at: at, feeding_type: "FORMULA", quantity_ml: 90 } }]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await alice.call("POST", "/assistant/chat", { messages: [{ role: "user", content: "gave 90ml formula 20 min ago" }] });
    expect(r.status).toBe(201);
    expect(r.body.proposals).toHaveLength(1);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.messages[0].content).toContain(baby.id);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key");

    const step = r.body.proposals[0].steps[0];
    const saved = await alice.call(step.method, step.path, step.body);
    expect(saved.status).toBe(201);
    expect(saved.body.quantity_ml).toBe(90);
  });

  it("drops a log_other that duplicates another entry, but keeps unrelated ones", async () => {
    const at = new Date(Date.now() - 10 * 60_000).toISOString().replace("Z", "+00:00");
    const later = new Date(Date.now() - 60_000).toISOString().replace("Z", "+00:00");
    globalThis.fetch = vi.fn().mockResolvedValue(llmReply([
      { name: "log_feeding", args: { baby_id: baby.id, occurred_at: at, feeding_type: "FORMULA", quantity_ml: 60, feeding_method: "BOTTLE" } },
      { name: "log_other", args: { baby_id: baby.id, occurred_at: at, title: "Feeding recorded", description: "60 ml formula given" } },
      { name: "log_other", args: { baby_id: baby.id, occurred_at: later, title: "Fever 100.4°F", is_important_medical: true } },
    ])) as unknown as typeof fetch;
    const r = await alice.call("POST", "/assistant/chat", { messages: [{ role: "user", content: "60 ml formula given 10 minutes ago, and now fever 100.4" }] });
    expect(r.body.proposals.map((p: { title: string }) => p.title)).toEqual(["Formula · 60 ml", "Fever 100.4°F"]);
    expect(r.body.reply).toBe("Here are 2 entries. Tap Save on each one.");
  });

  it("sends invalid tool arguments back to the model once to fix", async () => {
    const at = new Date(Date.now() - 60_000).toISOString().replace("Z", "+00:00");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(llmReply([{ name: "log_measurement", args: { baby_id: baby.id, measured_at: at } }]))
      .mockResolvedValueOnce(llmReply([{ name: "log_measurement", args: { baby_id: baby.id, measured_at: at, weight_kg: 5.1 } }]));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await alice.call("POST", "/assistant/chat", { messages: [{ role: "user", content: "weight 5.1" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_0" });
    expect(r.body.proposals.map((p: { title: string }) => p.title)).toEqual(["Weight 5.1 kg"]);
  });

  it("returns a friendly error when OpenRouter fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const r = await alice.call("POST", "/assistant/chat", { messages: [{ role: "user", content: "hi" }] });
    expect(r.status).toBe(502);
    expect(r.body.code).toBe("ASSISTANT_UNAVAILABLE");
  });
});
