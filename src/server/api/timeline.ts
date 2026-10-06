import "server-only";
import { z } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { badRequest, pageParams, requireIfMatch, zDateTime, type Router } from "../http";
import { audit, cursorClause, nextCursor, requireBaby, softDelete, upsertTimeline, versionedUpdate } from "../core";
import { storage } from "../storage";

const TYPES = ["BIRTH", "FEEDING", "WEIGHT", "VACCINE", "APPOINTMENT", "PRESCRIPTION", "MEDICINE", "ALLERGY", "MEDICAL_REPORT", "IMPORTANT_MEDICAL_EVENT", "CUSTOM"];
const HREF: Record<string, (b: string, id: string) => string> = {
  feeding: (b) => `/babies/${b}/feedings`, weight_measurement: (b) => `/babies/${b}/weight`, vaccination: (b) => `/babies/${b}/vaccinations`,
  appointment: (b, id) => `/babies/${b}/appointments/${id}`, prescription: (b, id) => `/babies/${b}/prescriptions/${id}`, medicine: (b) => `/babies/${b}/medicines`,
  allergy: (b) => `/babies/${b}/allergies`, medical_document: (b, id) => `/babies/${b}/documents/${id}`, baby: (b) => `/babies/${b}/profile`,
  feeding_plan: (b) => `/babies/${b}/milk`, custom_event: (b) => `/babies/${b}/timeline`,
};

export function registerTimeline(r: Router) {
  r.get("/babies/:babyId/timeline", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    const { limit, cursor } = pageParams(ctx.query);
    const types = (ctx.query.get("types") ?? "").split(",").filter(Boolean);
    if (types.some((t) => !TYPES.includes(t))) throw badRequest("Unknown event type");
    const params: unknown[] = [a.babyId, types.length ? types : null, ctx.query.get("from"), ctx.query.get("to")];
    // documents only for members with document access
    const hideDocs = !(a.canViewDocuments || a.role === "OWNER" || a.role === "GUARDIAN");
    const cc = cursorClause(cursor, "occurred_at", params.length + 1);
    params.push(...cc.value, limit);
    const rows = await ctx.q<{ id: string; baby_id: string; source_table: string; source_id: string; occurred_at: Date }>(
      `SELECT id, baby_id, event_type, occurred_at, occurred_tz, source_table, source_id, title, summary, importance FROM timeline_event
       WHERE baby_id = $1 AND NOT is_hidden AND ($2::text[] IS NULL OR event_type = ANY($2)) AND ($3::timestamptz IS NULL OR occurred_at >= $3) AND ($4::timestamptz IS NULL OR occurred_at <= $4)
       ${hideDocs ? "AND event_type <> 'MEDICAL_REPORT'" : ""}${cc.sql} ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`, params);
    return { data: rows.map((x) => ({ ...x, href: HREF[x.source_table]?.(x.baby_id, x.source_id) ?? null })), next_cursor: nextCursor(rows, limit, "occurred_at") };
  });

  r.get("/timeline", async (ctx) => {
    const ids = (ctx.query.get("baby_ids") ?? "").split(",").filter(Boolean);
    const babies = [];
    for (const id of ids.length ? ids : (await ctx.q<{ baby_id: string }>("SELECT baby_id FROM baby_membership WHERE user_id = $1 AND revoked_at IS NULL", [ctx.session!.userId])).map((x) => x.baby_id))
      babies.push(await requireBaby(ctx, id, "READ"));
    const docOk = babies.filter((b) => b.canViewDocuments || b.role === "OWNER" || b.role === "GUARDIAN").map((b) => b.babyId);
    const rows = await ctx.q<{ baby_id: string; source_table: string; source_id: string }>(
      `SELECT t.id, t.baby_id, b.first_name, b.colour_token, t.event_type, t.occurred_at, t.source_table, t.source_id, t.title, t.summary, t.importance
       FROM timeline_event t JOIN baby b ON b.id = t.baby_id WHERE t.baby_id = ANY($1) AND NOT t.is_hidden AND (t.event_type <> 'MEDICAL_REPORT' OR t.baby_id = ANY($2))
       ORDER BY t.occurred_at DESC LIMIT $3`, [babies.map((b) => b.babyId), docOk, pageParams(ctx.query).limit]);
    return { data: rows.map((x) => ({ ...x, href: HREF[x.source_table]?.(x.baby_id, x.source_id) ?? null })), next_cursor: null };
  });

  // custom / important events
  const ev = z.object({ occurred_at: zDateTime, title: z.string().trim().min(1).max(160), description: z.string().trim().max(2000).nullish(), is_important_medical: z.boolean().default(false) });
  r.post("/babies/:babyId/events", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const b = await ctx.body(ev);
    if (new Date(b.occurred_at).getTime() > Date.now() + 5 * 60_000) throw badRequest("Event time can't be in the future");
    const id = uuidv7();
    await ctx.q("INSERT INTO custom_event(id, baby_id, occurred_at, occurred_tz, title, description, is_important_medical, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, a.babyId, b.occurred_at, a.householdTz, b.title, b.description ?? null, b.is_important_medical, ctx.session!.userId]);
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: b.is_important_medical ? "IMPORTANT_MEDICAL_EVENT" : "CUSTOM", occurredAt: b.occurred_at, tz: a.householdTz, table: "custom_event", id, title: b.title, summary: b.description?.slice(0, 140), importance: b.is_important_medical ? 2 : 0 });
    await audit(ctx, "EVENT_CREATE", { babyId: a.babyId, table: "custom_event", id });
    return { id };
  });
  r.patch("/babies/:babyId/events/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(ev.partial());
    const rows = await ctx.q<{ occurred_at: Date; title: string; description: string | null; is_important_medical: boolean }>(
      `UPDATE custom_event SET occurred_at = coalesce($4, occurred_at), title = coalesce($5, title), description = coalesce($6, description), is_important_medical = coalesce($7, is_important_medical),
       version = version + 1, updated_at = now() WHERE id = $1 AND baby_id = $2 AND version = $3 AND deleted_at IS NULL RETURNING occurred_at, title, description, is_important_medical`,
      [ctx.params.id, a.babyId, v, b.occurred_at ?? null, b.title ?? null, b.description ?? null, b.is_important_medical ?? null]);
    if (!rows.length) throw badRequest("Event not found or changed by someone else");
    const e = rows[0];
    await upsertTimeline(ctx.q, { babyId: a.babyId, type: e.is_important_medical ? "IMPORTANT_MEDICAL_EVENT" : "CUSTOM", occurredAt: e.occurred_at, tz: a.householdTz, table: "custom_event", id: ctx.params.id, title: e.title, summary: e.description?.slice(0, 140), importance: e.is_important_medical ? 2 : 0 });
    await audit(ctx, "EVENT_UPDATE", { babyId: a.babyId, table: "custom_event", id: ctx.params.id });
    return { id: ctx.params.id };
  });
  r.delete("/babies/:babyId/events/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "LOG");
    const rows = await ctx.q("UPDATE custom_event SET deleted_at = now() WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL RETURNING id", [ctx.params.id, a.babyId]);
    if (!rows.length) throw badRequest("Event not found");
    await ctx.q("UPDATE timeline_event SET is_hidden = true WHERE source_table = 'custom_event' AND source_id = $1", [ctx.params.id]);
    await audit(ctx, "EVENT_DELETE", { babyId: a.babyId, table: "custom_event", id: ctx.params.id });
    return null;
  });

  // Avatar photo (not medical): visible to all members; served through a short-lived signed URL.
  r.get("/babies/:babyId/photo-url", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "READ");
    if (!a.baby.photo_document_id) return { url: null };
    const d = await ctx.q.one<{ vault_key: string; mime_detected: string }>("SELECT vault_key, mime_detected FROM medical_document WHERE id = $1 AND baby_id = $2 AND scan_status = 'CLEAN' AND deleted_at IS NULL", [a.baby.photo_document_id, a.babyId]);
    if (!d) return { url: null };
    return { url: await storage().presignGet(d.vault_key, { ttlSeconds: 300, filename: "photo", contentType: d.mime_detected, disposition: "inline" }), expires_at: DateTime.now().plus({ minutes: 5 }).toISO() };
  });

  void softDelete; void versionedUpdate;
}
