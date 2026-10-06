import { env } from "@/server/env";
import { scheduleNotifications, dispatchDue, markMissedDoses } from "@/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Every few minutes (Vercel Cron / external scheduler): plan reminders, send due ones, mark missed doses. */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const planned = await scheduleNotifications();
  const sent = await dispatchDue();
  const missed = await markMissedDoses();
  return Response.json({ planned, sent, missed });
}
