import "server-only";
import { z, type ZodType } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { localDateOf } from "@/lib/age";
import { SCHEDULES } from "../vaccines";
import type { LlmTool } from "../llm";

/**
 * Chat assistant tools. The model never writes data: each tool call is turned into a *proposal* — a list of calls to
 * the existing REST endpoints — that the user confirms with one tap. All validation, permissions, RLS, audit and
 * timeline handling stay in the endpoints themselves.
 */

export type AssistantBaby = {
  id: string; name: string; nickname: string | null; colour: string; role: string; birthDate: string; ageDisplay: string; householdId: string;
  medicines: { id: string; name: string; dose: string | null; status: string }[];
};
export type AssistantContext = {
  now: Date; tz: string; babies: AssistantBaby[]; currentBabyId: string | null;
  doctors: { id: string; name: string; householdId: string }[];
  clinics: { id: string; name: string; householdId: string }[];
};
export type ProposalStep = { method: "POST"; path: string; body: Record<string, unknown> };
export type Proposal = {
  id: string; kind: string; baby_id: string | null; title: string; details: string[];
  /** Executed in order by the client. `{{n.id}}` in a path is replaced with the id returned by step n. */
  steps: ProposalStep[];
  /** Set when the user's role can't save this; the client shows the reason instead of a Save button. */
  blocked?: string;
  /** Single LOG-level writes can be queued offline like the regular forms. */
  offline_ok: boolean;
};
export type AskUser = { question: string; options: string[] };

export class ToolArgError extends Error {}

const LOG_ROLES = ["OWNER", "GUARDIAN", "CAREGIVER"];
const MANAGE_ROLES = ["OWNER", "GUARDIAN"];

const VACCINE_CODES = [...new Map(Object.values(SCHEDULES).flat().map((d) => [d.code, d])).values()];

const iso = z.string().datetime({ offset: true }).describe("ISO 8601 date-time WITH timezone offset, e.g. 2026-10-06T14:40:00+05:30");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Calendar date YYYY-MM-DD");
const optText = (max: number, d?: string) => (d ? z.string().trim().max(max).nullish().describe(d) : z.string().trim().max(max).nullish());

type ToolDef<A> = {
  name: string;
  description: string;
  args: (babyId: ZodType<string>) => ZodType<A>;
  build: (a: A, ctx: AssistantContext) => Omit<Proposal, "id" | "kind">;
};
const def = <A,>(d: ToolDef<A>) => d as unknown as ToolDef<Record<string, unknown>>;

function baby(ctx: AssistantContext, id: string) {
  const b = ctx.babies.find((x) => x.id === id);
  if (!b) throw new ToolArgError(`Unknown baby_id ${id}. Use one of the listed babies.`);
  return b;
}
function need(b: AssistantBaby, level: "LOG" | "MANAGE"): string | undefined {
  const ok = (level === "LOG" ? LOG_ROLES : MANAGE_ROLES).includes(b.role);
  return ok ? undefined : level === "MANAGE" ? `Only a parent or guardian of ${b.name} can save this.` : `Your role can't add records for ${b.name}.`;
}
function doctor(ctx: AssistantContext, b: AssistantBaby, id: string | null | undefined) {
  if (!id) return null;
  const d = ctx.doctors.find((x) => x.id === id && x.householdId === b.householdId);
  if (!d) throw new ToolArgError(`Unknown doctor_id ${id}. Use an id from the doctors list, or leave it empty.`);
  return d;
}
function clinic(ctx: AssistantContext, b: AssistantBaby, id: string | null | undefined) {
  if (!id) return null;
  const c = ctx.clinics.find((x) => x.id === id && x.householdId === b.householdId);
  if (!c) throw new ToolArgError(`Unknown clinic_id ${id}. Use an id from the clinics list, or leave it empty.`);
  return c;
}
const when = (ctx: AssistantContext, isoStr: string) => DateTime.fromISO(isoStr).setZone(ctx.tz).toFormat("d LLL, h:mm a");
const day = (d: string) => DateTime.fromISO(d).toFormat("d LLL yyyy");
const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
const label = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export const TOOLS = [
  def({
    name: "log_feeding",
    description: "Record one feed: direct breastfeeding, expressed breast milk, formula or other. Direct breastfeeding NEVER has a volume.",
    args: (babyId) => z.object({
      baby_id: babyId,
      occurred_at: iso,
      feeding_type: z.enum(["DIRECT_BREASTFEEDING", "EXPRESSED_BREASTMILK", "FORMULA", "OTHER"]),
      feeding_method: z.enum(["BREAST", "BOTTLE", "CUP", "PALADAI", "SPOON", "TUBE", "OTHER"]).nullish(),
      quantity_ml: z.number().positive().nullish().describe("Required for expressed milk and formula. Not allowed for direct breastfeeding."),
      quantity_oz: z.number().positive().nullish().describe("Use instead of quantity_ml only when the user said ounces"),
      duration_minutes: z.number().int().min(0).max(240).nullish(),
      breast_side: z.enum(["LEFT", "RIGHT", "BOTH"]).nullish().describe("Direct breastfeeding only"),
      other_description: optText(200, "What was given, for OTHER feeds"),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const qty = a.quantity_ml != null ? `${a.quantity_ml} ml` : a.quantity_oz != null ? `${a.quantity_oz} oz` : null;
      const kind = { DIRECT_BREASTFEEDING: "Breastfeed", EXPRESSED_BREASTMILK: "Expressed breast milk", FORMULA: "Formula", OTHER: a.other_description ? `Other · ${a.other_description}` : "Other feed" }[a.feeding_type];
      return {
        baby_id: b.id, title: [kind, qty].filter(Boolean).join(" · "),
        details: [when(ctx, a.occurred_at), a.breast_side && `Side: ${label(a.breast_side)}`, a.duration_minutes != null && `${a.duration_minutes} min`, a.feeding_method && `By ${label(a.feeding_method)}`, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/feedings`, body: clean({ ...a, baby_id: undefined, occurred_tz: ctx.tz, client_id: uuidv7() }) }],
        blocked: need(b, "LOG"), offline_ok: true,
      };
    },
  }),

  def({
    name: "log_measurement",
    description: "Record weight, length/height and/or head circumference. Convert grams to kg and inches to cm.",
    args: (babyId) => z.object({
      baby_id: babyId,
      measured_at: iso,
      weight_kg: z.number().positive().nullish(),
      length_cm: z.number().positive().nullish(),
      length_position: z.enum(["RECUMBENT", "STANDING"]).nullish(),
      head_circumference_cm: z.number().positive().nullish(),
      measurement_source: z.enum(["HOME_SCALE", "CLINIC", "HOSPITAL", "ANGANWADI", "OTHER"]).default("HOME_SCALE"),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      if (a.weight_kg == null && a.length_cm == null && a.head_circumference_cm == null) throw new ToolArgError("Give at least one of weight_kg, length_cm, head_circumference_cm.");
      const parts = [a.weight_kg != null && `Weight ${a.weight_kg} kg`, a.length_cm != null && `Length ${a.length_cm} cm`, a.head_circumference_cm != null && `Head ${a.head_circumference_cm} cm`].filter(Boolean);
      return {
        baby_id: b.id, title: parts.join(" · "), details: [when(ctx, a.measured_at), `Measured at: ${label(a.measurement_source)}`, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/measurements`, body: clean({ ...a, baby_id: undefined, measured_tz: ctx.tz, client_id: uuidv7() }) }],
        blocked: need(b, "LOG"), offline_ok: true,
      };
    },
  }),

  def({
    name: "log_medicine_dose",
    description: "Record that a medicine dose was given (or skipped). Use medicine_id from the baby's medicine list when it matches; otherwise give medicine_name and it will be added as a new medicine first.",
    args: (babyId) => z.object({
      baby_id: babyId,
      medicine_id: z.string().nullish(),
      medicine_name: optText(160, "Required when medicine_id is not given"),
      status: z.enum(["GIVEN", "SKIPPED"]).default("GIVEN"),
      given_at: iso.nullish().describe("When it was given; omit for 'just now'"),
      dose_amount: z.number().positive().nullish().describe("Only if the user stated it"),
      dose_unit: z.enum(["ML", "MG", "DROPS", "TABLET", "SACHET", "PUFF", "OTHER"]).nullish(),
      notes: optText(500),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const givenAt = a.status === "GIVEN" ? (a.given_at ?? ctx.now.toISOString()) : null;
      const amount = a.dose_amount != null ? `${a.dose_amount} ${(a.dose_unit ?? "").toLowerCase()}`.trim() : null;
      const notes = [amount && `Amount given: ${amount}`, a.notes].filter(Boolean).join(". ") || null;
      const doseBody = clean({ status: a.status, given_at: givenAt, notes, client_id: uuidv7() });
      const byName = a.medicine_name ? b.medicines.find((m) => m.name.toLowerCase() === a.medicine_name!.toLowerCase()) : undefined;
      const med = (a.medicine_id && b.medicines.find((m) => m.id === a.medicine_id)) || byName;
      if (a.medicine_id && !med && !a.medicine_name) throw new ToolArgError(`medicine_id ${a.medicine_id} is not in ${b.name}'s medicine list. Pass medicine_name instead.`);
      const details = [givenAt ? when(ctx, givenAt) : "Skipped", amount && `Amount: ${amount}`, a.notes].filter(Boolean) as string[];
      if (med) {
        return {
          baby_id: b.id, title: `${med.name} · dose ${a.status === "GIVEN" ? "given" : "skipped"}`, details,
          steps: [{ method: "POST", path: `/babies/${b.id}/medicines/${med.id}/doses`, body: doseBody }],
          blocked: need(b, "LOG"), offline_ok: true,
        };
      }
      if (!a.medicine_name) throw new ToolArgError("Give medicine_name or a medicine_id from the list.");
      const startDate = localDateOf(givenAt ?? ctx.now, ctx.tz);
      return {
        baby_id: b.id, title: `${a.medicine_name} · dose ${a.status === "GIVEN" ? "given" : "skipped"}`,
        details: [...details, `${a.medicine_name} isn't in ${b.name}'s medicines yet, so it will be added too`],
        steps: [
          { method: "POST", path: `/babies/${b.id}/medicines`, body: clean({ medicine_name: a.medicine_name, dose_amount: a.dose_amount, dose_unit: a.dose_unit, start_date: startDate, status: "ACTIVE" }) },
          { method: "POST", path: `/babies/${b.id}/medicines/{{0.id}}/doses`, body: doseBody },
        ],
        blocked: need(b, "MANAGE") && `${a.medicine_name} isn't in ${b.name}'s medicines yet. A parent or guardian needs to add it first.`, offline_ok: false,
      };
    },
  }),

  def({
    name: "add_medicine",
    description: "Add a medicine the baby has been started on, with an optional reminder schedule. Record dosage exactly as stated; never calculate or suggest doses.",
    args: (babyId) => z.object({
      baby_id: babyId,
      medicine_name: z.string().trim().min(1).max(160),
      dose_amount: z.number().positive().nullish(),
      dose_unit: z.enum(["ML", "MG", "DROPS", "TABLET", "SACHET", "PUFF", "OTHER"]).nullish(),
      dose_text_as_prescribed: optText(400, "Dose wording as the user/doctor said it"),
      start_date: date.nullish().describe("Defaults to today"),
      end_date: date.nullish(),
      reason_as_given: optText(400),
      doctor_id: z.string().nullish(),
      schedule: z.object({
        kind: z.enum(["TIMES_OF_DAY", "EVERY_N_HOURS", "AS_NEEDED"]),
        times_of_day: z.array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)).max(12).nullish().describe("HH:MM 24h, for TIMES_OF_DAY"),
        every_n_hours: z.number().int().min(1).max(72).nullish(),
      }).nullish().describe("Only if the user said how often"),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const d = doctor(ctx, b, a.doctor_id);
      const start = a.start_date ?? localDateOf(ctx.now, ctx.tz);
      const s = a.schedule;
      if (s?.kind === "TIMES_OF_DAY" && !s.times_of_day?.length) throw new ToolArgError("schedule.times_of_day is required for TIMES_OF_DAY");
      if (s?.kind === "EVERY_N_HOURS" && !s.every_n_hours) throw new ToolArgError("schedule.every_n_hours is required for EVERY_N_HOURS");
      const schedText = s && (s.kind === "AS_NEEDED" ? "As needed" : s.kind === "EVERY_N_HOURS" ? `Every ${s.every_n_hours} h` : `At ${s.times_of_day!.join(", ")}`);
      const dose = a.dose_amount != null ? `${a.dose_amount} ${(a.dose_unit ?? "").toLowerCase()}`.trim() : a.dose_text_as_prescribed;
      return {
        baby_id: b.id, title: `Medicine · ${a.medicine_name}`,
        details: [dose && `Dose: ${dose}`, schedText, `From ${day(start)}${a.end_date ? ` to ${day(a.end_date)}` : ""}`, a.reason_as_given && `For: ${a.reason_as_given}`, d && `Dr ${d.name}`, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/medicines`, body: clean({ ...a, baby_id: undefined, start_date: start, schedule: s ? clean({ ...s, tz: ctx.tz }) : undefined }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_prescription",
    description: "Record a doctor's prescription verbatim (one or more medicines). Store text as written; never interpret or change dosage.",
    args: (babyId) => z.object({
      baby_id: babyId,
      prescribed_on: date.nullish().describe("Defaults to today"),
      doctor_id: z.string().nullish(),
      clinic_id: z.string().nullish(),
      diagnosis_text_as_written: optText(1000),
      items: z.array(z.object({
        medicine_name: z.string().trim().min(1).max(160),
        strength_text: optText(200), dosage_text: optText(400), frequency_text: optText(200), duration_text: optText(200), route_text: optText(100), instructions_text: optText(1000),
      })).max(30),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const d = doctor(ctx, b, a.doctor_id);
      clinic(ctx, b, a.clinic_id);
      const on = a.prescribed_on ?? localDateOf(ctx.now, ctx.tz);
      return {
        baby_id: b.id, title: `Prescription · ${day(on)}${d ? ` · Dr ${d.name}` : ""}`,
        details: [a.diagnosis_text_as_written && `Diagnosis: ${a.diagnosis_text_as_written}`, ...a.items.map((i) => [i.medicine_name, i.strength_text, i.dosage_text, i.frequency_text, i.duration_text].filter(Boolean).join(" · ")), a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/prescriptions`, body: clean({ ...a, baby_id: undefined, prescribed_on: on, items: a.items.map(clean) }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_allergy",
    description: "Record an allergy or a suspected allergy/reaction. Use SUSPECTED unless the user says a doctor confirmed it.",
    args: (babyId) => z.object({
      baby_id: babyId,
      substance: z.string().trim().min(1).max(120),
      category: z.enum(["FOOD", "DRUG", "ENVIRONMENTAL", "OTHER"]).nullish(),
      reaction_text: optText(1000, "What happened, in the user's words"),
      severity_reported: z.enum(["MILD", "MODERATE", "SEVERE", "UNKNOWN"]).default("UNKNOWN"),
      status: z.enum(["SUSPECTED", "CONFIRMED_BY_DOCTOR"]).default("SUSPECTED"),
      discovered_on: date.nullish(),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      return {
        baby_id: b.id, title: `Allergy · ${a.substance} (${a.status === "CONFIRMED_BY_DOCTOR" ? "confirmed by doctor" : "suspected"})`,
        details: [a.reaction_text && `Reaction: ${a.reaction_text}`, `Severity: ${label(a.severity_reported)}`, a.category && label(a.category), a.discovered_on && `Noticed ${day(a.discovered_on)}`, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/allergies`, body: clean({ ...a, baby_id: undefined }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "log_vaccination",
    description: "Record a vaccine dose that was given. Call once per vaccine dose. Use vaccine_code from the list when it clearly matches.",
    args: (babyId) => z.object({
      baby_id: babyId,
      vaccine_code: z.enum(VACCINE_CODES.map((v) => v.code) as [string, ...string[]]).nullish(),
      vaccine_name_as_recorded: z.string().trim().min(1).max(120),
      dose_label: optText(60),
      given_on: date,
      clinic_id: z.string().nullish(),
      given_by: optText(120),
      notes: optText(2000),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const c = clinic(ctx, b, a.clinic_id);
      return {
        baby_id: b.id, title: `Vaccine · ${a.vaccine_name_as_recorded}${a.dose_label ? ` (${a.dose_label})` : ""}`,
        details: [`Given ${day(a.given_on)}`, c && `At ${c.name}`, a.given_by && `By ${a.given_by}`, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/vaccinations`, body: clean({ ...a, baby_id: undefined }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_appointment",
    description: "Schedule (or record) a doctor visit, vaccination visit, follow-up, specialist visit or lab test.",
    args: (babyId) => z.object({
      baby_id: babyId,
      starts_at: iso,
      purpose: z.enum(["ROUTINE_CHECKUP", "VACCINATION", "FOLLOW_UP", "SPECIALIST", "LAB_TEST", "OTHER"]),
      doctor_id: z.string().nullish(),
      clinic_id: z.string().nullish(),
      notes_before: optText(4000, "Questions or notes for the visit"),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const d = doctor(ctx, b, a.doctor_id), c = clinic(ctx, b, a.clinic_id);
      return {
        baby_id: b.id, title: `Appointment · ${label(a.purpose)}`,
        details: [when(ctx, a.starts_at), d && `Dr ${d.name}`, c && c.name, a.notes_before].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/appointments`, body: clean({ ...a, baby_id: undefined, tz: ctx.tz }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_feeding_plan",
    description: "Record a feeding plan a doctor/nurse gave (e.g. '60 ml every 3 hours'). Record as instructed; never invent amounts.",
    args: (babyId) => z.object({
      baby_id: babyId,
      clinician_name: z.string().trim().min(1).max(120),
      plan_text: z.string().trim().min(1).max(2000),
      entered_from: z.enum(["PRESCRIPTION", "DISCHARGE_SUMMARY", "VERBAL_INSTRUCTION", "OTHER"]).default("VERBAL_INSTRUCTION"),
      instructed_on: date.nullish().describe("Defaults to today"),
      volume_ml_per_feed: z.number().positive().nullish(),
      feeds_per_day: z.number().int().min(1).max(24).nullish(),
      valid_from: date.nullish().describe("Defaults to instructed_on"),
      valid_to: date.nullish(),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      const on = a.instructed_on ?? localDateOf(ctx.now, ctx.tz);
      return {
        baby_id: b.id, title: `Feeding plan · ${a.clinician_name}`,
        details: [a.plan_text, a.volume_ml_per_feed != null && `${a.volume_ml_per_feed} ml per feed`, a.feeds_per_day != null && `${a.feeds_per_day} feeds/day`, `From ${day(a.valid_from ?? on)}`].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/feeding-plans`, body: clean({ ...a, baby_id: undefined, instructed_on: on, valid_from: a.valid_from ?? on }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_doctor",
    description: "Save a doctor to the family's directory.",
    args: (babyId) => z.object({ baby_id: babyId.describe("Any baby in the family the doctor is for"), name: z.string().trim().min(1).max(120), specialty: optText(80), phone: optText(30), notes: optText(1000) }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      return {
        baby_id: null, title: `Doctor · ${a.name}`, details: [a.specialty, a.phone, a.notes].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/households/${b.householdId}/doctors`, body: clean({ name: a.name, specialty: a.specialty, phone: a.phone, notes: a.notes }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "add_clinic",
    description: "Save a clinic or hospital to the family's directory.",
    args: (babyId) => z.object({ baby_id: babyId.describe("Any baby in the family the clinic is for"), name: z.string().trim().min(1).max(160), address: optText(400), phone: optText(30) }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      return {
        baby_id: null, title: `Clinic · ${a.name}`, details: [a.address, a.phone].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/households/${b.householdId}/clinics`, body: clean({ name: a.name, address: a.address, phone: a.phone }) }],
        blocked: need(b, "MANAGE"), offline_ok: false,
      };
    },
  }),

  def({
    name: "log_other",
    description: "Record something NO other tool covers: fever/temperature, vomiting, diaper/poop, sleep, rash, milestones. Never use it to repeat, confirm or annotate a feed, measurement, dose, vaccine, appointment or other entry made with another tool. Mark is_important_medical for symptoms a doctor should see.",
    args: (babyId) => z.object({
      baby_id: babyId,
      occurred_at: iso,
      title: z.string().trim().min(1).max(160),
      description: optText(2000),
      is_important_medical: z.boolean().default(false),
    }),
    build: (a, ctx) => {
      const b = baby(ctx, a.baby_id);
      return {
        baby_id: b.id, title: a.title, details: [when(ctx, a.occurred_at), a.description, a.is_important_medical && "Marked as important medical event"].filter(Boolean) as string[],
        steps: [{ method: "POST", path: `/babies/${b.id}/events`, body: clean({ ...a, baby_id: undefined }) }],
        blocked: need(b, "LOG"), offline_ok: true,
      };
    },
  }),
];

const askUserArgs = z.object({ question: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(60)).min(1).max(6) });
const ASK_USER = "ask_user";

function babyIdSchema(ctx: AssistantContext): ZodType<string> {
  return z.enum(ctx.babies.map((b) => b.id) as [string, ...string[]]).describe("id of the baby this entry is for");
}

export function toolDefinitions(ctx: AssistantContext): LlmTool[] {
  const babyId = babyIdSchema(ctx);
  return [
    ...TOOLS.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.args(babyId), { io: "input" }) } })),
    { type: "function", function: { name: ASK_USER, description: "Ask the user a short question with tap-able answer options, e.g. which baby an entry is for, or a missing required value.", parameters: z.toJSONSchema(askUserArgs) } },
  ];
}

export type ToolOutcome = { ok: true; proposal: Proposal } | { ok: true; ask: AskUser } | { ok: false; error: string };

export function runTool(name: string, rawArgs: string, ctx: AssistantContext): ToolOutcome {
  let json: unknown;
  try { json = JSON.parse(rawArgs); } catch { return { ok: false, error: "Arguments were not valid JSON." }; }
  if (name === ASK_USER) {
    const r = askUserArgs.safeParse(json);
    return r.success ? { ok: true, ask: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { ok: false, error: `Unknown tool ${name}.` };
  const r = t.args(babyIdSchema(ctx)).safeParse(json);
  if (!r.success) return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  try {
    return { ok: true, proposal: { id: uuidv7(), kind: name, ...t.build(r.data, ctx) } };
  } catch (e) {
    if (e instanceof ToolArgError) return { ok: false, error: e.message };
    throw e;
  }
}

const TIME_FIELDS = ["occurred_at", "measured_at", "given_at", "starts_at"] as const;
const instant = (p: Proposal) => {
  for (const s of p.steps) for (const f of TIME_FIELDS) if (typeof s.body[f] === "string") return Date.parse(s.body[f] as string);
  return null;
};

/** Models sometimes add a log_other "note" for an entry they already proposed; drop events that coincide with another entry. */
export function dropDuplicateEvents(proposals: Proposal[]): Proposal[] {
  return proposals.filter((p) => {
    if (p.kind !== "log_other") return true;
    const t = instant(p);
    return !proposals.some((o) => o !== p && o.kind !== "log_other" && o.baby_id === p.baby_id && t != null && instant(o) != null && Math.abs(instant(o)! - t) < 2 * 60_000);
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ALL_BABIES = /\b(both|all|twins|everyone|each)\b/i;
const named = (text: string, b: AssistantBaby) =>
  [b.name, b.nickname].filter(Boolean).some((n) => new RegExp(`(^|[^\\p{L}])${escapeRe(n!)}($|[^\\p{L}])`, "iu").test(text));

/**
 * Wrong-baby guard (spec §32.1): with more than one baby, an entry is only proposed for a baby the user actually named.
 * The most recent user message that names a baby (or says "both"/"all") sets who the conversation is about, so short
 * follow-ups like "make it 120 ml" keep that baby. Anything else becomes a "Who is this for?" question.
 */
export function requireNamedBaby(proposals: Proposal[], ctx: AssistantContext, userMessages: string[]): { proposals: Proposal[]; ask: AskUser | null } {
  if (ctx.babies.length < 2) return { proposals, ask: null };
  let focus: string[] = [];
  for (const text of [...userMessages].reverse()) {
    if (ALL_BABIES.test(text)) { focus = ctx.babies.map((b) => b.id); break; }
    const ids = ctx.babies.filter((b) => named(text, b)).map((b) => b.id);
    if (ids.length) { focus = ids; break; }
  }
  const kept = proposals.filter((p) => p.baby_id === null || focus.includes(p.baby_id));
  if (kept.length === proposals.length) return { proposals, ask: null };
  const ordered = [...ctx.babies].sort((a, b) => Number(b.id === ctx.currentBabyId) - Number(a.id === ctx.currentBabyId));
  return { proposals: kept, ask: { question: "Who is this for?", options: [...ordered.map((b) => b.name), ctx.babies.length === 2 ? "Both" : "All"] } };
}

export function systemPrompt(ctx: AssistantContext): string {
  const now = DateTime.fromJSDate(ctx.now).setZone(ctx.tz);
  const cur = ctx.babies.find((b) => b.id === ctx.currentBabyId);
  const babies = ctx.babies.map((b) => {
    const meds = b.medicines.length ? b.medicines.map((m) => `      - ${m.name}${m.dose ? ` (${m.dose})` : ""} [medicine_id ${m.id}, ${m.status.toLowerCase()}]`).join("\n") : "      (none)";
    return `  - ${b.name}${b.nickname ? ` "${b.nickname}"` : ""}: baby_id ${b.id}, born ${b.birthDate}, age ${b.ageDisplay}, user's role ${b.role}\n    Medicines:\n${meds}`;
  }).join("\n");
  const dir = (xs: { id: string; name: string }[]) => (xs.length ? xs.map((x) => `  - ${x.name} [id ${x.id}]`).join("\n") : "  (none)");
  return `You are the data-entry assistant inside "Baby Health", an app where parents log their baby's care. Parents are often holding a baby, so they type or dictate short, messy messages. Your only job is to turn each message into records using the tools.

Current time: ${now.toISO()} (${now.toFormat("cccc, d LLLL yyyy, h:mm a")}), timezone ${ctx.tz}.

Babies this user can access:
${babies}
${ctx.babies.length === 1 ? `There is only one baby, ${ctx.babies[0].name}; use it.` : `There are ${ctx.babies.length} babies. Unless the user names a baby (or says both/all), call ask_user "Who is this for?" with the baby names as options — never guess${cur ? `, even though the chat was opened from ${cur.name}'s screen` : ""}. Once a baby is named, follow-up corrections in the conversation apply to that baby.`}

Doctors:
${dir(ctx.doctors)}
Clinics:
${dir(ctx.clinics)}

Vaccine codes (use when one clearly matches): ${VACCINE_CODES.map((v) => `${v.code}=${v.vaccine} ${v.dose}`).join("; ")}

Rules:
- Call exactly one tool per real-world event. Never record the same event twice (e.g. a feed is ONLY log_feeding, never also log_other). A message can contain several events (and several babies): call a tool for each. "Both babies" means one call per baby.
- Pick the baby by name/nickname only.
- If the user corrects an earlier entry ("it was for X", "make it 120 ml"), propose the corrected entry again; the old card is withdrawn automatically.
- Convert relative times ("20 min ago", "at 3", "yesterday night") into ISO date-times with the ${now.toFormat("ZZ")} offset. "Now" or no time means the current time. Never use a time in the future for things that already happened.
- Use only values the user said. Do not invent amounts, doses, durations or dates. If a REQUIRED value is missing (e.g. formula amount), call ask_user.
- Direct breastfeeding has no volume. Bottle of breast milk = EXPRESSED_BREASTMILK. If the user only says "milk" or "bottle" with an amount and it is unclear whether it was breast milk or formula, call ask_user with options "Formula" and "Breast milk".
- Medicines and prescriptions are recorded exactly as stated. Never calculate, suggest or correct a dose.
- For a dose of a medicine already in the baby's list, pass its medicine_id.
- For doctors/clinics, pass the id only if the name matches the list above; otherwise mention the name in notes.
- Symptoms (fever, vomiting, rash, etc.) go to log_other with is_important_medical true. Reactions to a food/medicine also go to add_allergy as SUSPECTED.
- Never give medical advice, diagnoses or dosing guidance. If asked, say briefly that you can only record information and they should contact their doctor (or emergency services if urgent).
- Nothing is saved until the user taps Save on each card, so keep any text reply to one short sentence. If the message is not something to record, reply briefly and say what you can log.`;
}
