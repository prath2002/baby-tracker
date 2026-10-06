import "server-only";
import { z } from "zod";
import { DateTime } from "luxon";
import { uuidv7 } from "@/lib/ids";
import { localDateOf } from "@/lib/age";
import { ApiError, badRequest, notFound, zDate, type Ctx, type Router } from "../http";
import { audit, requireBaby, requireStepUp, type BabyAccess, type BabyRow } from "../core";
import { storage } from "../storage";
import { visitSummaryPdf } from "../pdf";
import { rangeSummary } from "./summaries";
import { babyDto } from "./babies";
import { randomToken, sha256 } from "../crypto";
import { zipStore, toCsv } from "../zip";
import { env } from "../env";
import webpush from "web-push";
import { planForUser } from "../notifications";

const TABLES: [string, string][] = [
  ["feedings", "SELECT * FROM feeding WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY occurred_at"],
  ["feeding_plans", "SELECT * FROM feeding_plan WHERE baby_id = $1 AND deleted_at IS NULL"],
  ["measurements", "SELECT * FROM weight_measurement WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY measured_at"],
  ["vaccinations", "SELECT * FROM vaccination WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY given_on"],
  ["appointments", "SELECT * FROM appointment WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY starts_at"],
  ["prescriptions", "SELECT * FROM prescription WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY prescribed_on"],
  ["prescription_items", "SELECT i.* FROM prescription_item i JOIN prescription p ON p.id = i.prescription_id WHERE i.baby_id = $1 AND p.deleted_at IS NULL"],
  ["medicines", "SELECT * FROM medicine WHERE baby_id = $1 AND deleted_at IS NULL"],
  ["medicine_doses", "SELECT * FROM medicine_dose WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY coalesce(given_at, scheduled_for, recorded_at)"],
  ["allergies", "SELECT * FROM allergy WHERE baby_id = $1 AND deleted_at IS NULL"],
  ["events", "SELECT * FROM custom_event WHERE baby_id = $1 AND deleted_at IS NULL ORDER BY occurred_at"],
  ["documents", "SELECT id, title, doc_type, document_date, description, tags, mime_detected, size_bytes, sha256, scan_status, created_at FROM medical_document WHERE baby_id = $1 AND deleted_at IS NULL"],
];

async function usedSources(ctx: Ctx) {
  // Only sources whose rules are displayable are cited (no pending values are shown in exports).
  return ctx.q("SELECT DISTINCT s.organization, s.document_title, s.publication_date, s.source_url FROM reference_source s JOIN reference_rule r ON r.source_id = s.source_id WHERE r.release_gate = 'CLEARED' ORDER BY 1");
}

export function registerExports(r: Router) {
  r.post("/exports", async (ctx) => {
    const b = await ctx.body(z.object({
      baby_id: z.string().uuid(), format: z.enum(["PDF_VISIT_SUMMARY", "JSON", "CSV"]),
      from: zDate.optional(), to: zDate.optional(), include_documents: z.boolean().default(false),
    }));
    const a = await requireBaby(ctx, b.baby_id, b.format === "PDF_VISIT_SUMMARY" ? "READ" : "MANAGE");
    if (b.format !== "PDF_VISIT_SUMMARY" || b.include_documents) requireStepUp(ctx);
    const today = localDateOf(new Date(), a.householdTz);
    const from = b.from ?? DateTime.fromISO(today).minus({ days: 29 }).toISODate()!, to = b.to ?? today;
    if (to < from) throw badRequest("'to' must be on or after 'from'");
    const recent = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM export_job WHERE requested_by = $1 AND created_at > now() - interval '1 day'", [ctx.session!.userId]);
    if ((recent?.n ?? 0) >= 10) throw new ApiError(429, "RATE_LIMITED", "Export limit reached", "You can create up to 10 exports per day.");
    const id = uuidv7();
    const key = `exports/${a.babyId}/${uuidv7()}`;
    let data: Buffer, mime: string;
    if (b.format === "PDF_VISIT_SUMMARY") {
      const summary = await rangeSummary(ctx, a, from, to, "VISIT SUMMARY");
      data = await visitSummaryPdf({ baby: await babyDto(ctx, a), summary, generatedAt: DateTime.now().setZone(a.householdTz).toFormat("d LLL yyyy, HH:mm"), generatedBy: ctx.session!.displayName, sources: await usedSources(ctx) });
      mime = "application/pdf";
    } else {
      const dump: Record<string, unknown[]> = {};
      for (const [name, sql] of TABLES) {
        if (name === "documents" && !(a.canViewDocuments || a.role === "OWNER" || a.role === "GUARDIAN")) continue;
        dump[name] = await ctx.q(sql, [a.babyId]);
      }
      const babyInfo = await babyDto(ctx, a);
      const files: { name: string; data: Buffer }[] = [];
      if (b.format === "JSON") files.push({ name: "baby-health-export.json", data: Buffer.from(JSON.stringify({ exported_at: new Date().toISOString(), baby: babyInfo, ...dump }, null, 2)) });
      else for (const [name, rows] of Object.entries(dump)) files.push({ name: `${name}.csv`, data: Buffer.from(toCsv(rows as Record<string, unknown>[])) });
      if (b.include_documents) {
        const docs = await ctx.q<{ id: string; title: string; vault_key: string; mime_detected: string }>("SELECT id, title, vault_key, mime_detected FROM medical_document WHERE baby_id = $1 AND deleted_at IS NULL AND scan_status = 'CLEAN'", [a.babyId]);
        for (const d of docs) files.push({ name: `documents/${d.id}-${d.title.slice(0, 40)}.${d.mime_detected === "application/pdf" ? "pdf" : d.mime_detected.split("/")[1]}`, data: await storage().get(d.vault_key) });
      }
      files.push({ name: "README.txt", data: Buffer.from("Exported from Baby Health. Parent-entered records. Reference information only; not a substitute for pediatric care.\n") });
      data = zipStore(files); mime = "application/zip";
    }
    await storage().put(key, data, mime);
    await ctx.q(`INSERT INTO export_job(id, requested_by, baby_id, scope, format, status, storage_key, expires_at) VALUES ($1,$2,$3,$4,$5,'READY',$6, now() + interval '24 hours')`,
      [id, ctx.session!.userId, a.babyId, JSON.stringify({ from, to, include_documents: b.include_documents }), b.format, key]);
    await audit(ctx, "EXPORT_CREATED", { babyId: a.babyId, table: "export_job", id, detail: { format: b.format, from, to, include_documents: b.include_documents } });
    return { id, status: "READY", format: b.format, size_bytes: data.length };
  });

  r.get("/exports/:id", async (ctx) => {
    const j = await ctx.q.one("SELECT id, baby_id, format, status, scope, expires_at, downloaded_at, created_at FROM export_job WHERE id = $1 AND requested_by = $2", [ctx.params.id, ctx.session!.userId]);
    if (!j) throw notFound("Export");
    return j;
  });

  r.post("/exports/:id/download-url", async (ctx) => {
    const j = await ctx.q.one<{ storage_key: string; format: string; expires_at: Date; baby_id: string; downloaded_at: Date | null }>(
      "SELECT storage_key, format, expires_at, baby_id, downloaded_at FROM export_job WHERE id = $1 AND requested_by = $2 AND status = 'READY'", [ctx.params.id, ctx.session!.userId]);
    if (!j) throw notFound("Export");
    if (j.expires_at.getTime() < Date.now()) throw new ApiError(410, "EXPORT_EXPIRED", "This export has expired. Create a new one.");
    if (j.downloaded_at) throw new ApiError(410, "EXPORT_ALREADY_DOWNLOADED", "Download links are single-use. Create a new export.");
    await requireBaby(ctx, j.baby_id, "READ");
    const pdf = j.format === "PDF_VISIT_SUMMARY";
    const url = await storage().presignGet(j.storage_key, { ttlSeconds: 300, filename: pdf ? "visit-summary.pdf" : "baby-health-export.zip", contentType: pdf ? "application/pdf" : "application/zip", disposition: "attachment" });
    await ctx.q("UPDATE export_job SET downloaded_at = now() WHERE id = $1", [ctx.params.id]);
    await audit(ctx, "EXPORT_DOWNLOAD_URL_ISSUED", { babyId: j.baby_id, table: "export_job", id: ctx.params.id });
    return { url, expires_at: new Date(Date.now() + 300_000).toISOString() };
  });

  // ---------- share links (time-boxed, read-only, scoped summary) ----------
  r.post("/babies/:babyId/share-links", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    requireStepUp(ctx);
    const b = await ctx.body(z.object({ from: zDate, to: zDate, expires_in_hours: z.number().int().min(1).max(168), max_views: z.number().int().min(1).max(50).nullish() }));
    if (b.to < b.from) throw badRequest("'to' must be on or after 'from'");
    const token = randomToken();
    const id = uuidv7();
    await ctx.q("INSERT INTO share_link(id, baby_id, created_by, scope, token_hash, expires_at, max_views) VALUES ($1,$2,$3,$4,$5, now() + make_interval(hours => $6), $7)",
      [id, a.babyId, ctx.session!.userId, JSON.stringify({ from: b.from, to: b.to }), sha256(token), b.expires_in_hours, b.max_views ?? null]);
    await audit(ctx, "SHARE_LINK_CREATED", { babyId: a.babyId, table: "share_link", id, detail: { from: b.from, to: b.to, hours: b.expires_in_hours } });
    return { id, url: `${env.APP_URL}/share/${token}`, expires_in_hours: b.expires_in_hours };
  });
  r.get("/babies/:babyId/share-links", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    return ctx.q("SELECT id, scope, expires_at, revoked_at, max_views, view_count, created_at FROM share_link WHERE baby_id = $1 ORDER BY created_at DESC", [a.babyId]);
  });
  r.delete("/babies/:babyId/share-links/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const rows = await ctx.q("UPDATE share_link SET revoked_at = now() WHERE id = $1 AND baby_id = $2 AND revoked_at IS NULL RETURNING id", [ctx.params.id, a.babyId]);
    if (!rows.length) throw notFound("Share link");
    await audit(ctx, "SHARE_LINK_REVOKED", { babyId: a.babyId, table: "share_link", id: ctx.params.id });
    return null;
  });
  r.get("/share/:token", async (ctx) => {
    // Public, token-scoped. Runs in system context; reads only the scoped baby and period.
    const link = await ctx.q.one<{ id: string; baby_id: string; scope: { from: string; to: string }; max_views: number | null; view_count: number }>(
      "SELECT id, baby_id, scope, max_views, view_count FROM share_link WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()", [sha256(ctx.params.token)]);
    if (!link || (link.max_views && link.view_count >= link.max_views)) throw notFound("Shared summary");
    await ctx.q("UPDATE share_link SET view_count = view_count + 1 WHERE id = $1", [link.id]);
    const baby = await ctx.q.one<BabyRow & { timezone: string }>(`SELECT b.id, b.household_id, b.first_name, b.nickname, b.colour_token, b.sex, to_char(b.birth_date,'YYYY-MM-DD') AS birth_date,
      to_char(b.birth_time,'HH24:MI') AS birth_time, b.birth_tz, b.multiple_birth_group_id, b.archived_at, b.photo_document_id, b.version, h.timezone FROM baby b JOIN household h ON h.id = b.household_id WHERE b.id = $1 AND b.deleted_at IS NULL`, [link.baby_id]);
    if (!baby) throw notFound("Shared summary");
    const access: BabyAccess = { babyId: baby.id, role: "VIEWER", canViewDocuments: false, householdId: baby.household_id, householdTz: baby.timezone, baby };
    const summary = await rangeSummary(ctx, access, link.scope.from, link.scope.to, "SHARED SUMMARY");
    await ctx.q("SELECT audit_append(NULL, $1, NULL, $2, 'SHARE_LINK_VIEWED', 'share_link', $3, NULL, $4)", [ctx.ip, link.baby_id, link.id, ctx.requestId]);
    return { baby: { first_name: baby.first_name, birth_date: baby.birth_date, sex: baby.sex, colour_token: baby.colour_token }, summary, read_only: true };
  }, { auth: "public", rateLimit: { bucket: "share", perMinute: 30 } });

  // ---------- audit ----------
  r.get("/audit", async (ctx) => {
    const babyId = ctx.query.get("baby_id");
    if (!babyId) throw badRequest("baby_id is required");
    const a = await requireBaby(ctx, babyId, "OWNER");
    const rows = await ctx.q(`SELECT l.id, l.occurred_at, l.action, l.entity_table, l.entity_id, u.display_name AS actor FROM audit_log l LEFT JOIN app_user u ON u.id = l.actor_user_id
      WHERE l.baby_id = $1 ORDER BY l.id DESC LIMIT 200`, [a.babyId]);
    const broken = await ctx.q.one<{ b: string | null }>("SELECT audit_verify_chain($1::text) AS b", [a.babyId]);
    return { data: rows, chain_intact: broken?.b === null, next_cursor: null };
  });

  // ---------- notifications ----------
  r.get("/notifications", async (ctx) => {
    await planForUser(ctx.session!.userId);
    return {
    data: await ctx.q(`SELECT n.id, n.baby_id, b.first_name, b.colour_token, n.kind, n.title, n.body, n.target_path, n.scheduled_for, n.read_at FROM notification n LEFT JOIN baby b ON b.id = n.baby_id
      WHERE n.user_id = $1 AND n.status IN ('SENT','PENDING') AND n.scheduled_for <= now() ORDER BY n.scheduled_for DESC LIMIT 100`, [ctx.session!.userId]),
    unread: (await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL AND status IN ('SENT','PENDING') AND scheduled_for <= now()", [ctx.session!.userId]))?.n ?? 0,
    };
  }, { auth: "user" });
  r.patch("/notifications/:id", async (ctx) => {
    await ctx.q("UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2", [ctx.params.id, ctx.session!.userId]);
    return { ok: true };
  }, { auth: "user" });
  r.post("/notifications/read-all", async (ctx) => {
    await ctx.q("UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND scheduled_for <= now()", [ctx.session!.userId]);
    return { ok: true };
  }, { auth: "user" });
  r.post("/devices", async (ctx) => {
    const b = await ctx.body(z.object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }));
    if (!/^https:\/\//.test(b.endpoint)) throw badRequest("Push endpoint must be https");
    await ctx.q(`INSERT INTO push_subscription(id, user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failure_count = 0`,
      [uuidv7(), ctx.session!.userId, b.endpoint, b.keys.p256dh, b.keys.auth]);
    return { ok: true };
  }, { auth: "user" });
  r.post("/devices/test", async (ctx) => {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new ApiError(409, "PUSH_NOT_CONFIGURED", "Push notifications aren't configured on this server");
    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const subs = await ctx.q<{ endpoint: string; p256dh: string; auth: string }>("SELECT endpoint, p256dh, auth FROM push_subscription WHERE user_id = $1", [ctx.session!.userId]);
    let ok = 0;
    for (const s of subs) { try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify({ title: "Notifications are working", path: "/notifications" })); ok++; } catch { /* ignore */ } }
    return { sent: ok };
  }, { auth: "user" });
  r.delete("/devices", async (ctx) => {
    const b = await ctx.body(z.object({ endpoint: z.string().url() }));
    await ctx.q("DELETE FROM push_subscription WHERE endpoint = $1 AND user_id = $2", [b.endpoint, ctx.session!.userId]);
    return null;
  }, { auth: "user" });
}
