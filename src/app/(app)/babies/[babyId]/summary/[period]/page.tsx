"use client";
import Link from "next/link";
import { use, useState } from "react";
import { DateTime } from "luxon";
import { api, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fmtDate, fmtDateTime, fmtKg, fmtMl } from "@/lib/format";
import { Badge, Button, Card, ErrorState, Loading, PageHeader, Stat, useToast } from "@/components/ui";
import { AllergyBanner, BabyNav, displayName, useBaby } from "@/components/baby";
import { ReferenceCard } from "@/components/reference";
import { DayBars } from "@/components/charts";

/** Daily / Weekly / Monthly summary (screens 12–14). */
export default function Summary({ params }: { params: Promise<{ babyId: string; period: string }> }) {
  const { babyId, period } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [offset, setOffset] = useState(0);
  const tz = baby?.household_timezone ?? "Asia/Kolkata";
  const now = DateTime.now().setZone(tz);
  let q = "";
  let label = "";
  if (period === "daily") { const d = now.plus({ days: offset }); q = `date=${d.toISODate()}`; label = offset === 0 ? "Today" : fmtDate(d.toISODate()); }
  else if (period === "weekly") { const w = now.startOf("week").plus({ weeks: offset }); q = `week=${w.weekYear}-W${String(w.weekNumber).padStart(2, "0")}`; label = `${fmtDate(w.toISODate())} – ${fmtDate(w.plus({ days: 6 }).toISODate())}`; }
  else { const m = now.startOf("month").plus({ months: offset }); q = `month=${m.toFormat("yyyy-LL")}`; label = m.toFormat("LLLL yyyy"); }
  const { data: s, error, loading, reload } = useApi<any>(baby ? `/babies/${babyId}/summaries/${period}?${q}` : null);
  const [busy, setBusy] = useState(false);
  if (!baby) return <Loading />;
  async function pdf() {
    setBusy(true);
    try {
      const e = await api("POST", "/exports", { body: { baby_id: babyId, format: "PDF_VISIT_SUMMARY", from: s.from, to: s.to } });
      const d = await api("POST", `/exports/${e.id}/download-url`);
      window.location.href = d.url;
    } catch (x) { toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  const f = s?.feeding;
  return (
    <>
      <PageHeader title={`${period[0].toUpperCase()}${period.slice(1)} summary`} subtitle={displayName(baby)} back={`/babies/${babyId}`} />
      <BabyNav babyId={babyId} active="summary/daily" />
      <nav aria-label="Summary period" className="mb-3 grid grid-cols-3 gap-2">{["daily", "weekly", "monthly"].map((p) => <Link key={p} href={`/babies/${babyId}/summary/${p}`} aria-current={p === period ? "page" : undefined} className={`flex min-h-10 items-center justify-center rounded-full text-sm font-semibold ${p === period ? "bg-ink text-canvas" : "border border-line bg-surface"}`}>{p[0].toUpperCase() + p.slice(1)}</Link>)}</nav>
      <div className="mb-3 flex items-center justify-between">
        <button className="min-h-12 min-w-12 text-2xl" aria-label="Previous" onClick={() => setOffset(offset - 1)}>‹</button>
        <p className="font-semibold">{label}</p>
        <button className="min-h-12 min-w-12 text-2xl disabled:opacity-30" aria-label="Next" disabled={offset >= 0} onClick={() => setOffset(offset + 1)}>›</button>
      </div>
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {s && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-ink-2">{baby.first_name} is {s.age.display}.</p>
          <AllergyBanner baby={baby} />
          <Card>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Feeding</h2><Badge tone={f.dataStatus === "NO_DATA" ? "neutral" : f.dataStatus === "PARTIAL_DATA" ? "caution" : "success"}>{f.dataStatus === "NO_DATA" ? "No data recorded" : f.dataStatus === "PARTIAL_DATA" ? "Some days recorded" : "Recorded"}</Badge></div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Measured milk" value={f.totalMeasuredMl != null ? fmtMl(f.totalMeasuredMl) : "—"} sub={f.avgMeasuredMlPerDayWithData != null ? `${fmtMl(f.avgMeasuredMlPerDayWithData)}/day over ${f.daysWithMeasuredData} day(s) with measured feeds` : "Not available"} />
              <Stat label="Breastfeeding sessions" value={f.directBreastfeedingSessions} sub="Not converted to volume" />
              <Stat label="Feeds" value={f.totalFeeds} sub={f.feedsPerDayAvg != null ? `${f.feedsPerDayAvg}/day on days with data` : undefined} />
              <Stat label="Days with data" value={`${f.daysWithAnyData}/${f.days.length}`} />
            </div>
            {period !== "daily" && <div className="mt-3"><DayBars label="Measured milk per day" days={f.days.map((x: any) => ({ date: x.localDate, value: x.measuredMl, hasAnyData: x.dataStatus === "RECORDED" }))} /></div>}
          </Card>
          {s.excretions && <Card>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Excretions</h2><Link href={`/babies/${babyId}/excretions`} className="text-sm font-semibold text-sage">History ›</Link></div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Wet" value={s.excretions.wet} />
              <Stat label="Dirty" value={s.excretions.dirty} />
              <Stat label="Vomit" value={s.excretions.vomit} />
            </div>
            <p className="mt-2 text-xs text-ink-2">Counts from your records. A diaper with pee and poop counts as both.</p>
          </Card>}
          {period === "daily" && <ReferenceCard r={s.reference} />}
          <Card>
            <h2 className="mb-2 text-lg font-bold">Weight & growth</h2>
            {s.weights.length ? <ul className="text-sm">{s.weights.map((w: any) => <li key={w.id}>{fmtDate(w.local_date)} · {[w.weight_kg != null && fmtKg(w.weight_kg), w.length_cm != null && `${w.length_cm} cm`, w.head_circumference_cm != null && `HC ${w.head_circumference_cm} cm`].filter(Boolean).join(" · ")} <span className="text-ink-2">({w.measurement_source.toLowerCase().replace("_", " ")})</span></li>)}</ul> : <p className="text-sm text-ink-2">No measurements recorded in this period.</p>}
            {s.weight_trend && <p className="mt-2 text-sm">Change: <b>{s.weight_trend.delta_g > 0 ? "+" : ""}{s.weight_trend.delta_g} g</b> over {s.weight_trend.days} days.</p>}
            <Link href={`/babies/${babyId}/growth`} className="mt-2 inline-block text-sm font-semibold text-sage">Growth reference ›</Link>
          </Card>
          <Card>
            <h2 className="mb-2 text-lg font-bold">Care</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {s.vaccinations.map((v: any) => <li key={v.id}>💉 {fmtDate(v.given_on)} · {v.vaccine_name_as_recorded} {v.dose_label}</li>)}
              {s.vaccine_plan?.due?.map((v: any) => <li key={v.code} className="text-ink-2">💉 Due: {v.dose_label}</li>)}
              {s.appointments.map((a: any) => <li key={a.id}>📅 {fmtDateTime(a.starts_at, tz)} · {a.purpose.toLowerCase().replace(/_/g, " ")} ({a.status.toLowerCase()})</li>)}
              {s.medicines.map((m: any) => <li key={m.id}>💊 {m.medicine_name} · {m.status.toLowerCase()} · doses marked given: {m.doses_given}</li>)}
              {s.documents.map((d: any) => <li key={d.id}>📄 {d.title}</li>)}
              {!s.vaccinations.length && !s.appointments.length && !s.medicines.length && !s.documents.length && <li className="text-ink-2">Nothing recorded in this period.</li>}
            </ul>
          </Card>
          {s.highlights.length > 0 && <Card><h2 className="mb-2 text-lg font-bold">Highlights</h2><ul className="text-sm">{s.highlights.map((h: any, i: number) => <li key={i}>{fmtDateTime(h.occurred_at, tz)} · {h.title}</li>)}</ul></Card>}
          <Card><h2 className="mb-1 font-bold">Data notes</h2><ul className="text-sm text-ink-2">{s.data_quality_notes.map((n: string) => <li key={n}>{n}</li>)}</ul><p className="mt-2 text-xs text-ink-2">{s.disclaimer}</p></Card>
          <Button busy={busy} onClick={pdf}>Download pediatrician PDF</Button>
        </div>
      )}
    </>
  );
}
