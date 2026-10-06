import { env, IS_PROD } from "@/server/env";
import { verifyPayload } from "@/server/crypto";
import { storage } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Development-only signed file endpoint backing STORAGE_DRIVER=local. Disabled in production. */
type Tok = { k: string; op: "put" | "get"; ct: string; len?: number; fn?: string; d?: string };
function check(req: Request, op: "put" | "get") {
  if (IS_PROD || env.STORAGE_DRIVER !== "local") return null;
  const t = new URL(req.url).searchParams.get("t");
  const p = t ? verifyPayload<Tok>(t) : null;
  return p && p.op === op ? p : null;
}
export async function PUT(req: Request) {
  const p = check(req, "put");
  if (!p) return new Response("Forbidden", { status: 403 });
  if ((req.headers.get("content-type") ?? "") !== p.ct) return new Response("Content-Type mismatch", { status: 400 });
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length !== p.len) return new Response("Content-Length mismatch", { status: 400 });
  await storage().put(p.k, buf, p.ct);
  return new Response(null, { status: 200 });
}
export async function GET(req: Request) {
  const p = check(req, "get");
  if (!p) return new Response("Forbidden", { status: 403 });
  const buf = await storage().get(p.k).catch(() => null);
  if (!buf) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(buf), { headers: { "Content-Type": p.ct, "Content-Disposition": `${p.d ?? "attachment"}; filename="${(p.fn ?? "file").replace(/[^\w.\- ]/g, "_")}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
