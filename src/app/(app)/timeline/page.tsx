"use client";
import Link from "next/link";
import { useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate, fmtTime } from "@/lib/format";
import { EmptyState, ErrorState, Loading, PageHeader } from "@/components/ui";
import { TimelineTabBar, dayCountText, tabTypes, useTimelineTab } from "@/components/timeline-tabs";
import { BabyChip } from "@/components/baby";
import { ICON } from "@/components/timeline-icons";

/** Unified timeline across babies (screen 30). Every item carries a mandatory baby chip. */
export default function UnifiedTimeline() {
  const { data: babies } = useApi<any>("/babies");
  const [selected, setSelected] = useState<string[] | null>(null);
  const [tab, setTab] = useTimelineTab();
  const ids = selected ?? babies?.data?.map((b: any) => b.id) ?? [];
  const types = tabTypes(tab);
  const { data, error, loading, reload } = useApi<any>(ids.length ? `/timeline?baby_ids=${ids.join(",")}&limit=100${types ? `&types=${types.join(",")}` : ""}` : null);
  const tz = babies?.data?.[0]?.household_timezone ?? "Asia/Kolkata";
  const rows = data?.data ?? [];
  const groups = rows.reduce((m: Record<string, any[]>, e: any) => { const k = new Date(e.occurred_at).toLocaleDateString("en-CA", { timeZone: tz }); (m[k] ??= []).push(e); return m; }, {});
  return (
    <>
      <PageHeader title="Timeline" subtitle="All babies" />
      {babies?.data?.length > 1 && <div className="mb-3 flex flex-wrap gap-2">{babies.data.map((b: any) => {
        const on = ids.includes(b.id);
        return <button key={b.id} aria-pressed={on} onClick={() => setSelected(on ? ids.filter((x: string) => x !== b.id) : [...ids, b.id])} className={`min-h-10 rounded-full border-2 px-3 text-sm font-semibold ${on ? "border-sage" : "border-line opacity-60"}`}>{b.first_name}</button>;
      })}</div>}
      <TimelineTabBar tab={tab} onChange={setTab} />
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !rows.length && <EmptyState title="Nothing yet" body="Events appear as you log them." />}
      {Object.entries(groups).map(([day, list]) => (
        <section key={day} className="mb-4">
          <h2 className="mb-1 flex items-baseline justify-between text-sm font-bold text-ink-2"><span>{fmtDate(day)}</span>{ids.length === 1 && <span className="num font-semibold">{dayCountText(tab, list as any[])}</span>}</h2>
          <ol className="card divide-y divide-line p-1">{(list as any[]).map((e) => (
            <li key={e.id}><Link href={e.href ?? "#"} className="flex min-h-14 items-center gap-3 px-3 py-2">
              <span aria-hidden className="w-6 text-center">{ICON[e.event_type]}</span>
              <span className="flex-1"><BabyChip name={e.first_name} colour={e.colour_token} /><span className="mt-0.5 block font-semibold">{e.title}</span>{e.summary && <span className="block text-sm text-ink-2">{e.summary}</span>}</span>
              <span className="num text-sm text-ink-2">{fmtTime(e.occurred_at, tz)}</span>
            </Link></li>))}</ol>
        </section>
      ))}
    </>
  );
}
