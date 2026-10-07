import "server-only";
import { z } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { localDateOf } from "@/lib/age";
import { ApiError, badRequest, conflict, notFound, pageParams, requireIfMatch, zDate, zDateTime, type Ctx, type Router } from "../http";
import { audit, checkEventTime, cursorClause, nextCursor, requireBaby, softDelete, upsertTimeline, versionedUpdate } from "../core";

/** Pee / poop / both / vomit, with a free-text note. Counts only — no thresholds or alerts (spec §197). */
export const EXCRETION_TYPES = ["URINE", "STOOL", "URINE_AND_STOOL", "VOMIT"] as const;

const fields = {
  occurred_at: zDateTime,
  occurred_tz: z.string().max(64).optional(),
  excretion_type: z.enum(EXCRETION_TYPES),
  notes: z.string().trim().max(2000).nullish(),
};
const createSchema = z.object({ ...fields, client_id: z.string().max(64).optional(), force: z.boolean().optional() });
const patchSchema = z.object(fields).partial();

type Row = { id: string; baby_id: string; occurred_at: Date; occurred_tz: string; excretion_type: string; notes: string | null; local_date: string; version: number } & Record<string, unknown>;

const SELECT = `SELECT id, baby_id, occurred_at, occurred_tz, to_char(local_date,'YYYY-MM-DD') AS local_date, excretion_type, notes, client_id, moved_from_baby_id,
  created_at, created_by, updated_at, version FROM excretion`;

export function excretionTitle(type: string) {
  return { URINE: "Pee", STOOL: "Poop", URINE_AND_STOOL: "Pee + poop", VOMIT: "Vomit" }[type] ?? "Excretion";
}

function timeline(babyId: string, r: { id: string; occurred_at: string | Date; occurred_tz: string; excretion_type: string; notes?: string | null }) {
  return { babyId, type: "EXCRETION" as const, occurredAt: r.occurred_at, tz: r.occurred_tz, table: "excretion", id: r.id, title: excretionTitle(r.excretion_type), summary: r.notes?.slice(0, 140) || null };
}

/** Wet = any entry with pee, dirty = any entry with poop; "Both" counts toward each. */
export async function excretionCounts(ctx: Ctx, babyId: string, from: string, to: string) {
  const r = await ctx.q.one<{ wet: number; dirty: number; vomit: number; total: number; last_at: Date | null }>(
    `SELECT count(*) FILTER (WHERE excretion_type IN ('URINE','URINE_AND_STOOL'))::int AS wet,
            count(*) FILTER (WHERE excretion_type IN ('STOOL','URINE_AND_STOOL'))::int AS dirty,
            count(*) FILTER (WHERE excretion_type = 'VOMIT')::int AS vomit,
            count(*)::int AS total, max(occurred_at) AS last_at
     FROM excretion WHERE baby_id = $1 AND deleted_at IS NULL AND local_date BETWEEN $2 AND $3`, [babyId, from, to]);
  return r ?? { wet: 0, dirty: 0, vomit: 0, total: 0, last_at: null };
}

export function registerExcretions(r: Router) {
  r.get("/babies/:babyId/excretions", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const { limit, cursor } = pageParams(ctx.query);
    const params: unknown[] = [a.babyId];
    let where = "WHERE baby_id = $1 AND deleted_at IS NULL";
    const type = ctx.query.get("type");
    if (type) { if (!EXCRETION_TYPES.includes(type as never)) throw badRequest("Unknown type"); params.push(type); where += ` AND excretion_type = $${params.length}`; }
    const from = ctx.query.get("from"), to = ctx.query.get("to");
    if (from) { params.push(from); where += ` AND occurred_at >= $${params.length}`; }
    if (to) { params.push(to); where += ` AND occurred_at <= $${params.length}`; }
    const cc = cursorClause(cursor, "occurred_at", params.length + 1);
    params.push(...cc.value);
    params.push(limit);
    const rows = await ctx.q<Row>(`${SELECT} ${where}${cc.sql} ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`, params);
    return { data: rows, next_cursor: nextCursor(rows, limit, "occurred_at") };
  });

  r.post("/babies/:babyId/excretions", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(createSchema);
    checkEventTime(a, b.occurred_at, "Entry");
    if (b.client_id) {
      const existing = await ctx.q.one<Row>(`${SELECT} WHERE baby_id = $1 AND client_id = $2`, [a.babyId, b.client_id]);
      if (existing) return existing; // offline replay
    }
    if (!b.force) {
      const dup = await ctx.q.one<Row>(`${SELECT} WHERE baby_id = $1 AND excretion_type = $2 AND deleted_at IS NULL
        AND abs(extract(epoch FROM (occurred_at - $3::timestamptz))) <= 120`, [a.babyId, b.excretion_type, b.occurred_at]);
      if (dup) throw conflict("DUPLICATE_SUSPECTED", "This looks like a duplicate of an entry recorded at almost the same time. Save anyway?", { duplicate_of: dup });
    }
    const id = uuidv7();
    const tz = b.occurred_tz || a.householdTz;
    await ctx.q(`INSERT INTO excretion(id, baby_id, occurred_at, occurred_tz, local_date, excretion_type, notes, client_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, a.babyId, b.occurred_at, tz, localDateOf(new Date(b.occurred_at), a.householdTz), b.excretion_type, b.notes || null, b.client_id ?? null, ctx.session!.userId]);
    await upsertTimeline(ctx.q, timeline(a.babyId, { id, occurred_at: b.occurred_at, occurred_tz: tz, excretion_type: b.excretion_type, notes: b.notes }));
    await audit(ctx, "EXCRETION_CREATE", { babyId: a.babyId, table: "excretion", id });
    return (await ctx.q.one<Row>(`${SELECT} WHERE id = $1`, [id]))!;
  });

  r.get("/babies/:babyId/excretions/summary", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const date = ctx.query.get("date") ?? localDateOf(new Date(), a.householdTz);
    zDate.parse(date);
    return { date, ...(await excretionCounts(ctx, a.babyId, date, date)) };
  });

  r.get("/babies/:babyId/excretions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const row = await ctx.q.one<Row>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!row) throw notFound("Entry");
    return row;
  });

  r.patch("/babies/:babyId/excretions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(patchSchema);
    const cur = await ctx.q.one<Row>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!cur) throw notFound("Entry");
    if (b.occurred_at) checkEventTime(a, b.occurred_at, "Entry");
    const occurredAt = b.occurred_at ?? cur.occurred_at.toISOString();
    const sets = {
      occurred_at: occurredAt, occurred_tz: b.occurred_tz ?? cur.occurred_tz, local_date: localDateOf(new Date(occurredAt), a.householdTz),
      excretion_type: b.excretion_type ?? cur.excretion_type, notes: b.notes !== undefined ? b.notes || null : cur.notes,
    };
    await versionedUpdate(ctx.q, "excretion", cur.id, a.babyId, v, sets, ctx.session!.userId);
    await upsertTimeline(ctx.q, timeline(a.babyId, { id: cur.id, ...sets }));
    await audit(ctx, "EXCRETION_UPDATE", { babyId: a.babyId, table: "excretion", id: cur.id, detail: { before: { excretion_type: cur.excretion_type, occurred_at: cur.occurred_at }, after: { excretion_type: sets.excretion_type, occurred_at: sets.occurred_at } } });
    return (await ctx.q.one<Row>(`${SELECT} WHERE id = $1`, [cur.id]))!;
  });

  r.delete("/babies/:babyId/excretions/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    await softDelete(ctx.q, "excretion", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "EXCRETION_DELETE", { babyId: a.babyId, table: "excretion", id: ctx.params.id });
    return null;
  });

  r.post("/babies/:babyId/excretions/:id/restore", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const rows = await ctx.q("UPDATE excretion SET deleted_at = NULL, deleted_by = NULL, version = version + 1 WHERE id = $1 AND baby_id = $2 AND deleted_at > now() - interval '1 day' RETURNING id", [ctx.params.id, a.babyId]);
    if (!rows.length) throw notFound("Entry");
    await ctx.q("UPDATE timeline_event SET is_hidden = false WHERE source_table = 'excretion' AND source_id = $1", [ctx.params.id]);
    await audit(ctx, "EXCRETION_RESTORE", { babyId: a.babyId, table: "excretion", id: ctx.params.id });
    return (await ctx.q.one<Row>(`${SELECT} WHERE id = $1`, [ctx.params.id]))!;
  });

  r.post("/babies/:babyId/excretions/:id/move", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(z.object({ target_baby_id: z.string().uuid() }));
    if (b.target_baby_id === a.babyId) throw badRequest("Target is the same baby");
    const t = await requireBaby(ctx, b.target_baby_id, "LOG");
    const v = requireIfMatch(ctx);
    const cur = await ctx.q.one<Row>(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!cur) throw notFound("Entry");
    if (cur.version !== v) throw new ApiError(412, "VERSION_MISMATCH", "This record was changed by someone else");
    const tBirth = DateTime.fromISO(t.baby.birth_date, { zone: t.baby.birth_tz }).startOf("day").toMillis();
    if (cur.occurred_at.getTime() < tBirth) throw badRequest("This entry is before the other baby's date of birth");
    await ctx.q(`UPDATE excretion SET baby_id = $3, moved_from_baby_id = $2, local_date = (occurred_at AT TIME ZONE $4)::date, client_id = NULL, version = version + 1, updated_at = now(), updated_by = $5 WHERE id = $1 AND baby_id = $2`,
      [cur.id, a.babyId, t.babyId, t.householdTz, ctx.session!.userId]);
    await ctx.q("UPDATE timeline_event SET baby_id = $2 WHERE source_table = 'excretion' AND source_id = $1", [cur.id, t.babyId]);
    await audit(ctx, "EXCRETION_MOVED", { babyId: a.babyId, table: "excretion", id: cur.id, detail: { from: a.babyId, to: t.babyId } });
    await audit(ctx, "EXCRETION_MOVED_IN", { babyId: t.babyId, table: "excretion", id: cur.id, detail: { from: a.babyId, to: t.babyId } });
    return (await ctx.q.one<Row>(`${SELECT} WHERE id = $1`, [cur.id]))!;
  });
}
