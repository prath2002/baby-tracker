import "server-only";
import { ApiError, forbidden, notFound, type Ctx } from "./http";
import { isUuid } from "@/lib/ids";
import { uuidv7 } from "@/lib/ids";
import type { Q } from "./db";
import { hasRecentStepUp } from "./auth/session";

export type Role = "OWNER" | "GUARDIAN" | "CAREGIVER" | "VIEWER";
export type Level = "READ" | "LOG" | "MANAGE" | "OWNER" | "DOCS";

const ALLOWED: Record<Level, Role[]> = {
  READ: ["OWNER", "GUARDIAN", "CAREGIVER", "VIEWER"],
  LOG: ["OWNER", "GUARDIAN", "CAREGIVER"],
  MANAGE: ["OWNER", "GUARDIAN"],
  OWNER: ["OWNER"],
  DOCS: ["OWNER", "GUARDIAN", "CAREGIVER", "VIEWER"],
};

export type BabyAccess = {
  babyId: string;
  role: Role;
  canViewDocuments: boolean;
  householdId: string;
  householdTz: string;
  baby: BabyRow;
};
export type BabyRow = {
  id: string; household_id: string; first_name: string; nickname: string | null; colour_token: string; sex: string;
  birth_date: string; birth_time: string | null; birth_tz: string; multiple_birth_group_id: string | null; archived_at: string | null;
  photo_document_id: string | null; version: number;
};

/**
 * Per-baby authorization (spec §32/§35). Unknown baby or no membership => 404 (no existence leak).
 * Known baby but insufficient role => 403.
 */
export async function requireBaby(ctx: Ctx, babyId: string, level: Level): Promise<BabyAccess> {
  if (!isUuid(babyId)) throw notFound("Baby");
  const userId = ctx.session!.userId;
  const m = await ctx.q.one<{ role: Role; can_view_documents: boolean }>(
    "SELECT role, can_view_documents FROM baby_membership WHERE baby_id = $1 AND user_id = $2 AND revoked_at IS NULL", [babyId, userId]);
  if (!m) throw notFound("Baby");
  const baby = await ctx.q.one<BabyRow & { timezone: string }>(
    `SELECT b.id, b.household_id, b.first_name, b.nickname, b.colour_token, b.sex, to_char(b.birth_date,'YYYY-MM-DD') AS birth_date,
            to_char(b.birth_time,'HH24:MI') AS birth_time, b.birth_tz, b.multiple_birth_group_id, b.archived_at, b.photo_document_id, b.version, h.timezone
     FROM baby b JOIN household h ON h.id = b.household_id WHERE b.id = $1 AND b.deleted_at IS NULL`, [babyId]);
  if (!baby) throw notFound("Baby");
  if (!ALLOWED[level].includes(m.role)) throw forbidden();
  if (level === "DOCS" && !(m.can_view_documents || m.role === "OWNER" || m.role === "GUARDIAN")) throw forbidden("Document access has not been granted for your role");
  return { babyId, role: m.role, canViewDocuments: m.can_view_documents, householdId: baby.household_id, householdTz: baby.timezone, baby };
}

export async function requireHousehold(ctx: Ctx, householdId: string, write = false) {
  if (!isUuid(householdId)) throw notFound("Household");
  const r = await ctx.q.one<{ ok: boolean; manager: boolean }>(
    `SELECT true AS ok,
       (EXISTS (SELECT 1 FROM household_member WHERE household_id = $1 AND user_id = $2 AND left_at IS NULL)
        OR EXISTS (SELECT 1 FROM baby_membership m JOIN baby_household_index bi ON bi.baby_id = m.baby_id
                   WHERE bi.household_id = $1 AND m.user_id = $2 AND m.revoked_at IS NULL AND m.role IN ('OWNER','GUARDIAN'))) AS manager
     WHERE app_in_household($1)`, [householdId, ctx.session!.userId]);
  if (!r) throw notFound("Household");
  if (write && !r.manager) throw forbidden();
}

export function requireStepUp(ctx: Ctx) {
  if (!hasRecentStepUp(ctx.session!)) throw new ApiError(401, "STEP_UP_REQUIRED", "Please confirm it's you", "Verify a one-time code to continue.");
}

export async function audit(ctx: Ctx, action: string, opts: { babyId?: string | null; table?: string; id?: string | null; detail?: unknown } = {}) {
  await ctx.q("SELECT audit_append($1,$2,$3,$4,$5,$6,$7,$8,$9)", [
    ctx.session?.userId ?? null, ctx.ip, ctx.session?.sessionId ?? null, opts.babyId ?? null, action,
    opts.table ?? null, opts.id ?? null, opts.detail === undefined ? null : JSON.stringify(opts.detail), ctx.requestId,
  ]);
}

export type TimelineType = "BIRTH" | "FEEDING" | "WEIGHT" | "VACCINE" | "APPOINTMENT" | "PRESCRIPTION" | "MEDICINE" | "ALLERGY" | "MEDICAL_REPORT" | "IMPORTANT_MEDICAL_EVENT" | "CUSTOM";

/** Timeline projection written in the same transaction as the source row (spec §25). */
export async function upsertTimeline(q: Q, e: {
  babyId: string; type: TimelineType; occurredAt: string | Date; tz: string; table: string; id: string; title: string; summary?: string | null; importance?: number; hidden?: boolean;
}) {
  await q(
    `INSERT INTO timeline_event(id, baby_id, event_type, occurred_at, occurred_tz, source_table, source_id, title, summary, importance, is_hidden)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source_table, source_id) DO UPDATE SET baby_id = EXCLUDED.baby_id, event_type = EXCLUDED.event_type, occurred_at = EXCLUDED.occurred_at,
       occurred_tz = EXCLUDED.occurred_tz, title = EXCLUDED.title, summary = EXCLUDED.summary, importance = EXCLUDED.importance, is_hidden = EXCLUDED.is_hidden`,
    [uuidv7(), e.babyId, e.type, e.occurredAt, e.tz, e.table, e.id, e.title, e.summary ?? null, e.importance ?? 0, e.hidden ?? false]);
}
export async function hideTimeline(q: Q, table: string, id: string) {
  await q("UPDATE timeline_event SET is_hidden = true WHERE source_table = $1 AND source_id = $2", [table, id]);
}

/** Optimistic-concurrency update helper: returns the updated row or throws 412/404. */
export async function versionedUpdate<T>(q: Q, table: string, id: string, babyId: string, expectedVersion: number, sets: Record<string, unknown>, userId: string): Promise<T> {
  const keys = Object.keys(sets);
  const assignments = keys.map((k, i) => `${k} = $${i + 5}`);
  assignments.push("version = version + 1", "updated_at = now()", "updated_by = $4");
  const rows = await q<T & { version: number }>(
    `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $1 AND baby_id = $2 AND version = $3 AND deleted_at IS NULL RETURNING *`,
    [id, babyId, expectedVersion, userId, ...keys.map((k) => sets[k])]);
  if (rows.length) return rows[0];
  const exists = await q.one<{ version: number }>(`SELECT version FROM ${table} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [id, babyId]);
  if (!exists) throw notFound();
  throw new ApiError(412, "VERSION_MISMATCH", "This record was changed by someone else", `Current version is ${exists.version}. Reload and try again.`);
}

export async function softDelete(q: Q, table: string, id: string, babyId: string, userId: string) {
  const rows = await q(`UPDATE ${table} SET deleted_at = now(), deleted_by = $3, version = version + 1 WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL RETURNING id`, [id, babyId, userId]);
  if (!rows.length) throw notFound();
  await hideTimeline(q, table, id);
}

export function cursorClause(cursor: string | null, column: string, paramIndex: number, desc = true): { sql: string; value: unknown[] } {
  if (!cursor) return { sql: "", value: [] };
  try {
    const [ts, id] = Buffer.from(cursor, "base64url").toString().split("|");
    if (!ts || !isUuid(id)) return { sql: "", value: [] };
    return { sql: ` AND (${column}, id) ${desc ? "<" : ">"} ($${paramIndex}::timestamptz, $${paramIndex + 1}::uuid)`, value: [ts, id] };
  } catch { return { sql: "", value: [] }; }
}
export function nextCursor(rows: { id: string }[], limit: number, column: string) {
  if (rows.length < limit) return null;
  const last = rows[rows.length - 1] as Record<string, unknown> & { id: string };
  const v = last[column];
  return Buffer.from(`${v instanceof Date ? v.toISOString() : String(v)}|${last.id}`).toString("base64url");
}
