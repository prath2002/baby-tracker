import "server-only";
import { z } from "zod";
import { calculateBabyAge } from "@/lib/age";
import { isUuid } from "@/lib/ids";
import { rateLimit, type Ctx, type Router } from "../http";
import { audit, requireBaby } from "../core";
import { env } from "../env";
import { assistantEnabled, chatCompletion, type LlmMessage } from "../llm";
import { dropDuplicateEvents, requireNamedBaby, runTool, systemPrompt, toolDefinitions, type AskUser, type AssistantContext, type Proposal } from "../assistant/tools";

const chatSchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(2000) })).min(1).max(20),
  baby_id: z.string().nullish(),
});

async function loadContext(ctx: Ctx, currentBabyId: string | null): Promise<AssistantContext> {
  const ids = await ctx.q<{ baby_id: string }>(
    `SELECT m.baby_id FROM baby_membership m JOIN baby b ON b.id = m.baby_id
     WHERE m.user_id = $1 AND m.revoked_at IS NULL AND b.deleted_at IS NULL AND b.archived_at IS NULL ORDER BY b.birth_date, b.first_name`, [ctx.session!.userId]);
  const now = new Date();
  const babies: AssistantContext["babies"] = [];
  let tz = "Asia/Kolkata";
  for (const { baby_id } of ids) {
    const a = await requireBaby(ctx, baby_id, "READ");
    tz = a.householdTz;
    const meds = await ctx.q<{ id: string; medicine_name: string; dose_amount: number | null; dose_unit: string | null; dose_text_as_prescribed: string | null; status: string }>(
      `SELECT id, medicine_name, dose_amount::float, dose_unit, dose_text_as_prescribed, status FROM medicine WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY status, start_date DESC LIMIT 40`, [baby_id]);
    babies.push({
      id: baby_id, name: a.baby.first_name, nickname: a.baby.nickname, colour: a.baby.colour_token, role: a.role, birthDate: a.baby.birth_date, householdId: a.householdId,
      ageDisplay: calculateBabyAge({ birthDate: a.baby.birth_date, birthTime: a.baby.birth_time, birthTz: a.baby.birth_tz }, now, a.householdTz).display,
      medicines: meds.map((m) => ({ id: m.id, name: m.medicine_name, status: m.status, dose: m.dose_amount != null ? `${m.dose_amount} ${(m.dose_unit ?? "").toLowerCase()}`.trim() : m.dose_text_as_prescribed })),
    });
  }
  const current = currentBabyId && babies.find((b) => b.id === currentBabyId);
  if (current) tz = (await requireBaby(ctx, current.id, "READ")).householdTz;
  const households = [...new Set(babies.map((b) => b.householdId))];
  const dir = (table: "doctor" | "clinic") => households.length
    ? ctx.q<{ id: string; name: string; household_id: string }>(`SELECT id, name, household_id FROM ${table} WHERE household_id = ANY($1) AND deleted_at IS NULL ORDER BY name LIMIT 100`, [households])
        .then((rows) => rows.map((r) => ({ id: r.id, name: r.name, householdId: r.household_id })))
    : Promise.resolve([]);
  return { now, tz, babies, currentBabyId: current ? current.id : null, doctors: await dir("doctor"), clinics: await dir("clinic") };
}

/** Assistant transcript sent back with the next turn so the model knows what it already proposed. */
const summarise = (p: Proposal, ctx: AssistantContext) =>
  `[proposed for ${ctx.babies.find((b) => b.id === p.baby_id)?.name ?? "family"}: ${p.title}${p.details.length ? ` — ${p.details.join(", ")}` : ""}]`;

export function registerAssistant(r: Router) {
  r.get("/assistant/status", async () => ({ enabled: assistantEnabled(), model: assistantEnabled() ? env.OPENROUTER_MODEL : null }));

  r.post("/assistant/chat", async (ctx) => {
    const body = await ctx.body(chatSchema);
    await rateLimit(`assistant:user:${ctx.session!.userId}`, 3600, 200);
    const ac = await loadContext(ctx, body.baby_id && isUuid(body.baby_id) ? body.baby_id : null);
    if (!ac.babies.length) return { reply: "Add a baby first, then I can log things for them.", proposals: [], ask: null, transcript: "" };

    const tools = toolDefinitions(ac);
    const messages: LlmMessage[] = [{ role: "system", content: systemPrompt(ac) }, ...body.messages];
    const proposals: Proposal[] = [];
    let ask: AskUser | null = null;
    let reply: string | null = null;

    // Up to two rounds: if any tool call has invalid arguments, the errors go back to the model once to fix.
    for (let round = 0; round < 2; round++) {
      const res = await chatCompletion(messages, tools);
      reply = res.content ?? reply;
      if (!res.toolCalls.length) break;
      const errors: { id: string; error: string }[] = [];
      const results: { id: string; text: string }[] = [];
      for (const call of res.toolCalls) {
        const out = runTool(call.name, call.arguments, ac);
        if (!out.ok) { errors.push({ id: call.id, error: out.error }); results.push({ id: call.id, text: `ERROR: ${out.error}` }); }
        else if ("ask" in out) { ask = out.ask; results.push({ id: call.id, text: "Question shown to the user." }); }
        else { proposals.push(out.proposal); results.push({ id: call.id, text: "Shown to the user for confirmation. Do not call again." }); }
      }
      if (!errors.length || round === 1) {
        if (errors.length && !proposals.length && !ask) reply = reply ?? "Sorry, I couldn't understand all of that. Could you say it a little differently?";
        break;
      }
      messages.push({ role: "assistant", content: res.content, tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
      for (const x of results) messages.push({ role: "tool", tool_call_id: x.id, content: x.text });
    }

    const guarded = requireNamedBaby(dropDuplicateEvents(proposals), ac, body.messages.filter((m) => m.role === "user").map((m) => m.content));
    proposals.splice(0, proposals.length, ...guarded.proposals);
    ask = guarded.ask ?? ask;
    if (ask) reply = ask.question;
    if (!reply) reply = proposals.length ? (proposals.length === 1 ? "Here's what I understood. Tap Save to add it." : `Here are ${proposals.length} entries. Tap Save on each one.`) : "I can log feeds, pee/poop/vomit, weight, medicines, allergies, vaccines, appointments and more. What happened?";
    await audit(ctx, "ASSISTANT_CHAT", { detail: { proposals: proposals.map((p) => p.kind), model: env.OPENROUTER_MODEL } });
    return { reply, proposals, ask, transcript: [reply, ...proposals.map((p) => summarise(p, ac))].join("\n") };
  }, { rateLimit: { bucket: "assistant", perMinute: 30 } });
}
