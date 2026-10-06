import { env } from "@/server/env";
import { purgeDue } from "@/server/purge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily: hard-purge deletion requests past their 30-day window, expire exports, clean housekeeping tables. */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  return Response.json(await purgeDue());
}
