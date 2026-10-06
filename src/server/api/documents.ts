import "server-only";
import { z } from "zod";
import { uuidv7 } from "@/lib/ids";
import { ApiError, badRequest, conflict, notFound, pageParams, requireIfMatch, zDate, type Ctx, type Router } from "../http";
import { audit, requireBaby, softDelete, upsertTimeline, versionedUpdate } from "../core";
import { storage } from "../storage";
import { ALLOWED_MIME, MAX_UPLOAD_BYTES, pdfActiveContent, pdfPageCount, sanitizeImage, scanBuffer, sniffMime } from "../files";
import { sha256 } from "../crypto";

const DOC_TYPES = ["LAB_REPORT", "IMAGING", "DISCHARGE_SUMMARY", "PRESCRIPTION_SCAN", "VACCINATION_CARD", "BIRTH_RECORD", "INSURANCE", "PHOTO", "OTHER"] as const;
const meta = {
  title: z.string().trim().min(1).max(160),
  doc_type: z.enum(DOC_TYPES),
  document_date: zDate.nullish(),
  doctor_id: z.string().uuid().nullish(),
  clinic_id: z.string().uuid().nullish(),
  description: z.string().trim().max(2000).nullish(),
  tags: z.array(z.string().trim().min(1).max(30)).max(12).default([]),
};
const SELECT = `SELECT id, baby_id, title, doc_type, to_char(document_date,'YYYY-MM-DD') AS document_date, doctor_id, clinic_id, description, tags, declared_mime,
  mime_detected, size_bytes, page_count, upload_status, scan_status, scan_detail, scanned_at, version, created_at FROM medical_document`;

/** Validation + scanning pipeline: quarantine object -> sniff -> active-content check -> malware scan -> sanitise -> vault. */
export async function processUpload(ctx: Ctx, babyId: string, docId: string) {
  const d = await ctx.q.one<{ quarantine_key: string; declared_mime: string; declared_size: number; title: string; doc_type: string; document_date: string | null; upload_status: string }>(
    "SELECT quarantine_key, declared_mime, declared_size, title, doc_type, to_char(document_date,'YYYY-MM-DD') AS document_date, upload_status FROM medical_document WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL FOR UPDATE", [docId, babyId]);
  if (!d) throw notFound("Document");
  if (d.upload_status === "PROCESSED" || d.upload_status === "REJECTED") return;
  const st = storage();
  const head = await st.head(d.quarantine_key);
  if (!head) throw new ApiError(409, "UPLOAD_NOT_FOUND", "The file hasn't been uploaded yet");
  const reject = async (code: string, detail: string, scan: "REJECTED" | "INFECTED" | "ERROR" = "REJECTED") => {
    await st.delete(d.quarantine_key);
    await ctx.q("UPDATE medical_document SET upload_status = $3, scan_status = $4, scan_detail = $5, scanned_at = now() WHERE id = $1 AND baby_id = $2",
      [docId, babyId, scan === "ERROR" ? "UPLOADED" : "REJECTED", scan, detail]);
    await audit(ctx, `DOCUMENT_${scan}`, { babyId, table: "medical_document", id: docId, detail: { code, detail } });
  };
  if (head.size > MAX_UPLOAD_BYTES || head.size !== Number(d.declared_size)) return reject("SIZE_MISMATCH", "File size does not match the declared size or exceeds 20 MB");
  const buf = await st.get(d.quarantine_key);
  const mime = sniffMime(buf);
  const declaredFamily = (m: string) => (m === "image/heif" ? "image/heic" : m);
  if (!mime || declaredFamily(mime) !== declaredFamily(d.declared_mime)) return reject("TYPE_MISMATCH", "File contents don't match the declared type");
  if (mime === "application/pdf") {
    const active = pdfActiveContent(buf);
    if (active) return reject("PDF_ACTIVE_CONTENT", `PDF contains ${active}, which isn't allowed for safety`);
  }
  const scan = await scanBuffer(buf);
  if (scan.status === "INFECTED") return reject("MALWARE", scan.detail, "INFECTED");
  if (scan.status === "ERROR") {
    await ctx.q("UPDATE medical_document SET upload_status = 'UPLOADED', scan_status = 'ERROR', scan_detail = $3 WHERE id = $1 AND baby_id = $2", [docId, babyId, scan.detail]);
    return;
  }
  let out = buf, outMime: string = mime, pages: number | null = null;
  if (mime.startsWith("image/")) {
    try { const s = await sanitizeImage(buf, mime); out = s.data; outMime = s.mime; }
    catch { return reject("IMAGE_DECODE_FAILED", mime === "image/heic" || mime === "image/heif" ? "HEIC images can't be processed on this server. Please upload a JPEG or PNG." : "The image could not be processed"); }
  } else pages = pdfPageCount(buf);
  const vaultKey = `vault/${babyId}/${uuidv7()}`;
  await st.put(vaultKey, out, outMime);
  await st.delete(d.quarantine_key);
  await ctx.q(`UPDATE medical_document SET vault_key = $3, mime_detected = $4, size_bytes = $5, sha256 = $6, page_count = $7, upload_status = 'PROCESSED', scan_status = 'CLEAN', scan_detail = $8, scanned_at = now()
               WHERE id = $1 AND baby_id = $2`, [docId, babyId, vaultKey, outMime, out.length, sha256(out), pages, scan.detail]);
  if (d.doc_type !== "PHOTO") await upsertTimeline(ctx.q, { babyId, type: "MEDICAL_REPORT", occurredAt: d.document_date ? `${d.document_date}T12:00:00Z` : new Date().toISOString(), tz: "UTC", table: "medical_document", id: docId, title: `Document added · ${d.title}` });
  await audit(ctx, "DOCUMENT_CLEAN", { babyId, table: "medical_document", id: docId });
}

export function registerDocuments(r: Router) {
  r.get("/babies/:babyId/documents", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "DOCS");
    const { limit } = pageParams(ctx.query);
    const qtext = ctx.query.get("q"), tag = ctx.query.get("tag"), type = ctx.query.get("type");
    const rows = await ctx.q(`${SELECT} WHERE baby_id = $1 AND deleted_at IS NULL AND doc_type <> 'PHOTO' AND ($2::text IS NULL OR title ILIKE '%' || $2 || '%') AND ($3::text IS NULL OR $3 = ANY(tags))
      AND ($4::text IS NULL OR doc_type = $4) ORDER BY document_date DESC NULLS LAST, created_at DESC LIMIT $5`, [a.babyId, qtext, tag, type, limit]);
    return { data: rows, next_cursor: null };
  });

  r.post("/babies/:babyId/documents/upload-intents", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const b = await ctx.body(z.object({ ...meta, file_name: z.string().max(200), declared_mime: z.enum(ALLOWED_MIME), size_bytes: z.number().int().positive() }));
    if (b.size_bytes > MAX_UPLOAD_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "File too large", "The maximum size is 20 MB.");
    const recent = await ctx.q.one<{ n: number }>("SELECT count(*)::int AS n FROM medical_document WHERE created_by = $1 AND created_at > now() - interval '1 hour'", [ctx.session!.userId]);
    if ((recent?.n ?? 0) >= 30) throw new ApiError(429, "RATE_LIMITED", "Too many uploads", "Please try again later.", undefined, { "Retry-After": "3600" });
    const id = uuidv7();
    const qkey = `quarantine/${a.babyId}/${uuidv7()}`;
    await ctx.q(`INSERT INTO medical_document(id, baby_id, title, doc_type, document_date, doctor_id, clinic_id, description, tags, declared_mime, declared_size, quarantine_key, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, a.babyId, b.title, b.doc_type, b.document_date ?? null, b.doctor_id ?? null, b.clinic_id ?? null, b.description ?? null, b.tags, b.declared_mime, b.size_bytes, qkey, ctx.session!.userId]);
    const put = await storage().presignPut(qkey, b.declared_mime, b.size_bytes, 300);
    await audit(ctx, "DOCUMENT_UPLOAD_INTENT", { babyId: a.babyId, table: "medical_document", id });
    return { document_id: id, upload_url: put.url, required_headers: put.headers, method: "PUT", expires_in_s: 300 };
  });

  r.post("/babies/:babyId/documents/:id/complete", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await ctx.q("UPDATE medical_document SET upload_status = 'UPLOADED' WHERE id = $1 AND baby_id = $2 AND upload_status = 'AWAITING_UPLOAD'", [ctx.params.id, a.babyId]);
    await processUpload(ctx, a.babyId, ctx.params.id);
    const doc = await ctx.q.one(`${SELECT} WHERE id = $1`, [ctx.params.id]);
    return new Response(JSON.stringify(doc), { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  });

  r.get("/babies/:babyId/documents/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "DOCS");
    const d = await ctx.q.one(`${SELECT} WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL`, [ctx.params.id, a.babyId]);
    if (!d) throw notFound("Document");
    return d;
  });

  r.patch("/babies/:babyId/documents/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    const v = requireIfMatch(ctx);
    const b = await ctx.body(z.object(meta).partial());
    await versionedUpdate(ctx.q, "medical_document", ctx.params.id, a.babyId, v, Object.fromEntries(Object.entries(b).filter(([, x]) => x !== undefined)), ctx.session!.userId);
    await audit(ctx, "DOCUMENT_UPDATE", { babyId: a.babyId, table: "medical_document", id: ctx.params.id });
    return ctx.q.one(`${SELECT} WHERE id = $1`, [ctx.params.id]);
  });

  r.delete("/babies/:babyId/documents/:id", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "MANAGE");
    await softDelete(ctx.q, "medical_document", ctx.params.id, a.babyId, ctx.session!.userId);
    await audit(ctx, "DOCUMENT_DELETE", { babyId: a.babyId, table: "medical_document", id: ctx.params.id });
    return null;
  });

  r.post("/babies/:babyId/documents/:id/view-url", async (ctx) => {
    const a = await requireBaby(ctx, ctx.params.babyId, "DOCS");
    const b = await ctx.body(z.object({ disposition: z.enum(["inline", "attachment"]).default("inline") }));
    const d = await ctx.q.one<{ vault_key: string | null; scan_status: string; mime_detected: string; title: string }>(
      "SELECT vault_key, scan_status, mime_detected, title FROM medical_document WHERE id = $1 AND baby_id = $2 AND deleted_at IS NULL", [ctx.params.id, a.babyId]);
    if (!d) throw notFound("Document");
    if (d.scan_status !== "CLEAN" || !d.vault_key) throw conflict("SCAN_NOT_CLEAN", "This document isn't available until the safety scan has passed");
    const ext = d.mime_detected === "application/pdf" ? "pdf" : d.mime_detected.split("/")[1];
    const url = await storage().presignGet(d.vault_key, { ttlSeconds: 300, filename: `${d.title}.${ext}`, contentType: d.mime_detected, disposition: b.disposition });
    await audit(ctx, "DOCUMENT_VIEW_URL_ISSUED", { babyId: a.babyId, table: "medical_document", id: ctx.params.id, detail: { disposition: b.disposition } });
    return { url, expires_at: new Date(Date.now() + 300_000).toISOString(), mime: d.mime_detected };
  });

  void badRequest;
}
