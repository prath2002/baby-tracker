"use client";
import Link from "next/link";
import { api } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDateTime } from "@/lib/format";
import { Button, EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import { BabyChip } from "@/components/baby";

/** Notifications inbox (screen 31). */
export default function Notifications() {
  const { data, error, loading, reload } = useApi<any>("/notifications");
  async function readAll() { await api("POST", "/notifications/read-all", { idempotent: false }); invalidate("/notifications"); reload(); }
  async function open(n: any) { if (!n.read_at) { await api("PATCH", `/notifications/${n.id}`, { body: {} }).catch(() => {}); invalidate("/notifications"); } }
  return (
    <>
      <PageHeader title="Notifications" action={data?.unread > 0 && <Button variant="ghost" className="min-h-10 text-sm" onClick={readAll}>Mark all read</Button>} />
      <Link href="/settings#notifications" className="mb-3 inline-block text-sm font-semibold text-sage">Notification settings ›</Link>
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.data.length && <EmptyState icon="🔔" title="You're all caught up" />}
      <ul className="flex flex-col gap-2">{data?.data.map((n: any) => (
        <li key={n.id}><Link href={n.target_path ?? "#"} onClick={() => open(n)} className={`card flex flex-col gap-1 p-3 ${n.read_at ? "opacity-70" : ""}`}>
          <div className="flex items-center justify-between gap-2">{n.first_name ? <BabyChip name={n.first_name} colour={n.colour_token} /> : <span />}<span className="text-xs text-ink-2">{fmtDateTime(n.scheduled_for)}</span></div>
          <p className="font-semibold">{!n.read_at && <span className="mr-1 inline-block h-2 w-2 rounded-full bg-allergy align-middle" aria-label="unread" />}{n.title}</p>
          {n.body && <p className="text-sm text-ink-2">{n.body}</p>}
        </Link></li>))}</ul>
    </>
  );
}
