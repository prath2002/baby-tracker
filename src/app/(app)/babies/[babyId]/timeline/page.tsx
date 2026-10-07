"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate, fmtTime } from "@/lib/format";
import { Button, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Select, Sheet, Textarea, Toggle, useToast } from "@/components/ui";
import { HIGHLIGHT_TYPES, TimelineTabBar, dayCountText, tabTypes, useTimelineTab } from "@/components/timeline-tabs";
import { BabyNav, displayName, useBaby, canLog } from "@/components/baby";
import { api, errorText } from "@/lib/api";
import { localInputToIso, nowLocalInput } from "@/lib/format";
import { ICON } from "@/components/timeline-icons";


/** Baby timeline (part of screen 30). */
export default function BabyTimeline({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [tab, setTab] = useTimelineTab();
  const [type, setType] = useState("");
  const types = (tab === "highlights" && type) || tabTypes(tab)?.join(",") || "";
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/timeline?limit=100${types ? `&types=${types}` : ""}`);
  const [ev, setEv] = useState<any>(null);
  if (!baby) return <Loading />;
  const groups = (data?.data ?? []).reduce((m: Record<string, any[]>, e: any) => { const k = new Date(e.occurred_at).toLocaleDateString("en-CA", { timeZone: baby.household_timezone }); (m[k] ??= []).push(e); return m; }, {});
  async function saveEvent(e: React.FormEvent) {
    e.preventDefault();
    try { await api("POST", `/babies/${babyId}/events`, { body: { occurred_at: localInputToIso(ev.when, baby!.household_timezone), title: ev.title, description: ev.desc || null, is_important_medical: ev.important } }); setEv(null); reload(); toast({ text: "Event added" }); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title="Timeline" subtitle={displayName(baby)} action={canLog(baby.my_role) && <Button className="min-h-10 px-4 text-sm" onClick={() => setEv({ when: nowLocalInput(baby.household_timezone), title: "", desc: "", important: false })}>+ Event</Button>} />
      <BabyNav babyId={babyId} active="timeline" />
      <TimelineTabBar tab={tab} onChange={setTab} />
      {tab === "highlights" && <div className="mb-3"><Select aria-label="Filter" value={type} onChange={(e) => setType(e.target.value)}><option value="">All highlights</option>{HIGHLIGHT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ").toLowerCase()}</option>)}</Select></div>}
      {tab === "feeds" && <p className="mb-3 text-sm"><Link className="font-semibold text-sage" href={`/babies/${babyId}/feedings`}>Edit feeds in feeding history ›</Link></p>}
      {tab === "excretions" && <p className="mb-3 text-sm"><Link className="font-semibold text-sage" href={`/babies/${babyId}/excretions`}>Edit entries in excretion history ›</Link></p>}
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.data.length && <EmptyState title="Nothing yet" body={tab === "excretions" ? "Pee, poop and vomit you log appear here." : tab === "feeds" ? "Feeds you log appear here." : "Events appear here as you log."} />}
      {Object.entries(groups).map(([day, list]) => (
        <section key={day} className="mb-4">
          <h2 className="mb-1 flex items-baseline justify-between text-sm font-bold text-ink-2"><span>{fmtDate(day)}</span><span className="num font-semibold">{dayCountText(tab, list as any[])}</span></h2>
          <ol className="card divide-y divide-line p-1">{(list as any[]).map((e) => (
            <li key={e.id}><Link href={e.href ?? "#"} className="flex min-h-14 items-center gap-3 px-3 py-2">
              <span aria-hidden className="w-6 text-center text-lg">{ICON[e.event_type]}</span>
              <span className="flex-1"><span className="block font-semibold">{e.title}</span>{e.summary && <span className="block text-sm text-ink-2">{e.summary}</span>}</span>
              <span className="num text-sm text-ink-2">{fmtTime(e.occurred_at, baby.household_timezone)}</span>
            </Link></li>))}</ol>
        </section>
      ))}
      <Sheet open={!!ev} onClose={() => setEv(null)} title="Add event">
        {ev && <form onSubmit={saveEvent} className="flex flex-col gap-3">
          <Field label="When">{(id) => <Input id={id} type="datetime-local" value={ev.when} onChange={(e) => setEv({ ...ev, when: e.target.value })} />}</Field>
          <Field label="Title" required>{(id) => <Input id={id} required value={ev.title} onChange={(e) => setEv({ ...ev, title: e.target.value })} />}</Field>
          <Field label="Details">{(id) => <Textarea id={id} value={ev.desc} onChange={(e) => setEv({ ...ev, desc: e.target.value })} />}</Field>
          <Toggle checked={ev.important} onChange={(v) => setEv({ ...ev, important: v })} label="Important medical event" />
          <Button type="submit" disabled={!ev.title}>Save</Button>
        </form>}
      </Sheet>
    </>
  );
}
