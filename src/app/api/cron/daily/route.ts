import { env } from "@/server/env";
import { purgeDue } from "@/server/purge";
import { scheduleNotifications, markMissedDoses } from "@/server/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily: plan the next 26 h of in-app reminders, mark missed doses, hard-purge deletion requests past their 30-day
 * window, expire exports, clean housekeeping tables. Reminders show in the in-app Alerts inbox once their time
 * arrives; nothing is pushed to devices (the /api/cron/dispatch job is not scheduled).
 */
export async function GET(req: Request) {
  if (!env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) return new Response("Unauthorized", { status: 401 });
  const planned = await scheduleNotifications();
  const missed = await markMissedDoses();
  return Response.json({ planned, missed, purge: await purgeDue() });
}
