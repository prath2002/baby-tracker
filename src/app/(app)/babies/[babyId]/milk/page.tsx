"use client";
import Link from "next/link";
import { use, useState } from "react";
import { DateTime } from "luxon";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtMl, fmtTime } from "@/lib/format";
import { Button, Card, ErrorState, Field, Input, LinkButton, Loading, Notice, PageHeader, Select, Sheet, Stat, Textarea, useToast } from "@/components/ui";
import { BabyNav, displayName, useBaby, canLog, canManage } from "@/components/baby";
import { ReferenceCard } from "@/components/reference";
import { DayBars } from "@/components/charts";

/** Milk dashboard (screen 9). */
export default function Milk({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [date, setDate] = useState<string | null>(null);
  const today = baby ? DateTime.now().setZone(baby.household_timezone).toISODate()! : null;
  const d = date ?? today;
  const { data: s, error, reload } = useApi<any>(d ? `/babies/${babyId}/feedings/summary?date=${d}` : null);
  const { data: week } = useApi<any>(`/babies/${babyId}/summaries/weekly?rolling=true`);
  const { data: recent } = useApi<any>(d ? `/babies/${babyId}/feedings?limit=10&from=${DateTime.fromISO(d, { zone: baby?.household_timezone }).startOf("day").toUTC().toISO()}&to=${DateTime.fromISO(d, { zone: baby?.household_timezone }).endOf("day").toUTC().toISO()}` : null);
  const [planOpen, setPlanOpen] = useState(false);
  const [plan, setPlan] = useState({ entered_from: "DISCHARGE_SUMMARY", clinician_name: "", instructed_on: "", plan_text: "", volume: "", feeds: "", valid_from: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!baby || !d) return <Loading />;
  const shift = (n: number) => { const nd = DateTime.fromISO(d).plus({ days: n }).toISODate()!; if (nd <= today! && nd >= baby.birth_date) setDate(nd); };
  async function savePlan(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api("POST", `/babies/${babyId}/feeding-plans`, { body: { entered_from: plan.entered_from, clinician_name: plan.clinician_name, instructed_on: plan.instructed_on, plan_text: plan.plan_text,
        volume_ml_per_feed: plan.volume ? Number(plan.volume) : null, feeds_per_day: plan.feeds ? Number(plan.feeds) : null, valid_from: plan.valid_from || plan.instructed_on } });
      setPlanOpen(false); invalidate(`/babies/${babyId}`); reload(); toast({ text: "Care-team plan recorded" });
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Milk & feeding" subtitle={displayName(baby)} action={canLog(baby.my_role) && <LinkButton href={`/babies/${babyId}/feedings/new`} className="min-h-10 px-4 text-sm">+ Feed</LinkButton>} />
      <BabyNav babyId={babyId} active="milk" />
      <div className="mb-3 flex items-center justify-between">
        <button onClick={() => shift(-1)} className="min-h-12 min-w-12 rounded-full text-2xl" aria-label="Previous day">‹</button>
        <p className="font-semibold">{d === today ? "Today" : fmtDate(d)}</p>
        <button onClick={() => shift(1)} disabled={d === today} className="min-h-12 min-w-12 rounded-full text-2xl disabled:opacity-30" aria-label="Next day">›</button>
      </div>
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {s && (
        <div className="flex flex-col gap-4">
          <Card>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Measured milk" value={s.measuredMl != null ? fmtMl(s.measuredMl) : "—"} sub={s.measuredMl != null ? `Expressed ${fmtMl(s.measuredMlByType.EXPRESSED_BREASTMILK)} · Formula ${fmtMl(s.measuredMlByType.FORMULA)}` : "Not available"} />
              <Stat label="Breastfeeding sessions" value={s.directBreastfeedingSessions} sub="Not converted to volume" />
              <Stat label="All feeds" value={s.totalFeedCount} sub={s.otherCount ? `${s.otherCount} other` : undefined} />
              <Stat label="Avg measured feed" value={s.averageMeasuredFeedMl != null ? fmtMl(s.averageMeasuredFeedMl) : "—"} sub={s.median_interval_min ? `median gap ${Math.floor(s.median_interval_min / 60)}h ${s.median_interval_min % 60}m` : undefined} />
            </div>
            <ul className="mt-3 flex flex-col gap-1 text-sm">{s.messages.map((m: string) => <li key={m}>{m}</li>)}</ul>
            {s.plan_comparison && <p className="mt-2 rounded-xl bg-sage-soft p-2 text-sm">{s.plan_comparison}</p>}
          </Card>
          <ReferenceCard r={s.reference} />
          {canManage(baby.my_role) && <Button variant="secondary" onClick={() => setPlanOpen(true)}>Record my care team's feeding plan</Button>}
          {week && <Card><DayBars label="Measured milk — last 7 days" days={week.feeding.days.map((x: any) => ({ date: x.localDate, value: x.measuredMl, hasAnyData: x.dataStatus === "RECORDED" }))} />
            <p className="mt-2 text-sm text-ink-2">{week.feeding.avgMeasuredMlPerDayWithData != null ? `Average ${fmtMl(week.feeding.avgMeasuredMlPerDayWithData)}/day over ${week.feeding.daysWithMeasuredData} of 7 days with measured feeds.` : "No measured feeds in the last 7 days."}</p></Card>}
          <Card>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Feeds this day</h2><Link href={`/babies/${babyId}/feedings`} className="text-sm font-semibold text-sage">History ›</Link></div>
            {!recent?.data?.length ? <p className="text-sm text-ink-2">No feeds recorded.</p> : <ul className="divide-y divide-line">{recent.data.map((f: any) => <li key={f.id} className="flex min-h-12 items-center justify-between text-sm"><span className="num text-ink-2">{fmtTime(f.occurred_at, baby.household_timezone)}</span><span className="flex-1 px-3 font-semibold">{({ DIRECT_BREASTFEEDING: "Breastfeed", EXPRESSED_BREASTMILK: "Expressed milk", FORMULA: "Formula", OTHER: "Other" } as any)[f.feeding_type]}</span><span className="num">{f.quantity_ml != null ? `${f.quantity_ml} ml` : f.duration_minutes ? `${f.duration_minutes} min` : ""}</span></li>)}</ul>}
          </Card>
        </div>
      )}
      <Sheet open={planOpen} onClose={() => setPlanOpen(false)} title="Care-team feeding plan">
        <form onSubmit={savePlan} className="flex flex-col gap-3">
          <Notice>Record the plan exactly as your doctor or neonatal team gave it. This becomes the reference shown for {baby.first_name}.</Notice>
          <Field label="From">{(id) => <Select id={id} value={plan.entered_from} onChange={(e) => setPlan({ ...plan, entered_from: e.target.value })}><option value="DISCHARGE_SUMMARY">Discharge summary</option><option value="PRESCRIPTION">Prescription</option><option value="VERBAL_INSTRUCTION">Verbal instruction</option><option value="OTHER">Other</option></Select>}</Field>
          <Field label="Doctor / care team" required>{(id) => <Input id={id} required value={plan.clinician_name} onChange={(e) => setPlan({ ...plan, clinician_name: e.target.value })} />}</Field>
          <Field label="Date given" required>{(id) => <Input id={id} type="date" required max={today!} value={plan.instructed_on} onChange={(e) => setPlan({ ...plan, instructed_on: e.target.value })} />}</Field>
          <Field label="Plan (as written)" required>{(id) => <Textarea id={id} required value={plan.plan_text} onChange={(e) => setPlan({ ...plan, plan_text: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="ml per feed (if stated)">{(id) => <Input id={id} inputMode="decimal" value={plan.volume} onChange={(e) => setPlan({ ...plan, volume: e.target.value })} />}</Field>
            <Field label="Feeds per day (if stated)">{(id) => <Input id={id} inputMode="numeric" value={plan.feeds} onChange={(e) => setPlan({ ...plan, feeds: e.target.value })} />}</Field>
          </div>
          {err && <Notice tone="allergy">{err}</Notice>}
          <Button type="submit" busy={busy}>Save plan</Button>
        </form>
      </Sheet>
    </>
  );
}
