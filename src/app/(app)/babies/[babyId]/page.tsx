"use client";
import Link from "next/link";
import { use, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate, fmtDateTime, fmtKg, fmtMl } from "@/lib/format";
import { ErrorState, Loading, Notice, Stat } from "@/components/ui";
import { AllergyBanner, BabyAvatar, BabyNav, displayName, useBaby, canLog } from "@/components/baby";
import { ReferenceCard } from "@/components/reference";

/** Baby Overview (screen 8). */
export default function Overview({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby, error, reload } = useBaby(babyId);
  const { data: today } = useApi<any>(`/babies/${babyId}/feedings/summary`);
  const { data: weights } = useApi<any>(`/babies/${babyId}/measurements?limit=2`);
  const { data: tl } = useApi<any>(`/babies/${babyId}/timeline?limit=5`);
  const { data: meds } = useApi<any>(`/babies/${babyId}/medicines?status=ACTIVE`);
  // Fixed per mount: a fresh timestamp each render would change the cache key and refetch in a loop.
  const [from] = useState(() => new Date().toISOString());
  const { data: appts } = useApi<any>(`/appointments?baby_id=${babyId}&status=SCHEDULED&from=${from}`);
  if (error) return <ErrorState message={error.problem.detail ?? error.message} onRetry={reload} />;
  if (!baby) return <Loading />;
  const w = weights?.data?.find((x: any) => x.weight_kg != null);
  return (
    <>
      <header className="mb-3 flex items-center gap-3">
        <BabyAvatar baby={baby} size={64} />
        <div className="flex-1"><h1 className="text-2xl font-extrabold">{displayName(baby)}</h1><p className="text-ink-2">{baby.age.display} · born {fmtDate(baby.birth_date)}</p></div>
      </header>
      <BabyNav babyId={babyId} active="" />
      <div className="flex flex-col gap-4">
        <AllergyBanner baby={baby} />
        {baby.categories.length > 0 && <Notice tone="info">Birth category: {baby.categories.map((c) => c.replace(/_/g, " ").toLowerCase()).join(", ")} (WHO definitions). Follow your baby's care team for feeding and growth.</Notice>}
        <section className="card p-4" aria-labelledby="today-h">
          <div className="mb-2 flex items-center justify-between"><h2 id="today-h" className="text-lg font-bold">Today</h2><Link href={`/babies/${babyId}/summary/daily`} className="text-sm font-semibold text-sage">Daily summary ›</Link></div>
          {today ? (
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Feeds" value={today.totalFeedCount} sub={`${today.directBreastfeedingSessions} breastfeeding sessions`} />
              <Stat label="Measured milk" value={today.measuredMl != null ? fmtMl(today.measuredMl) : "—"} sub={today.measuredMl == null ? "Not available" : `${today.measuredFeedCount} measured feeds`} />
              <Stat label="Last feed" value={today.lastFeedAt ? fmtDateTime(today.lastFeedAt, baby.household_timezone).split(", ")[1] : "—"} />
              <Stat label="Weight" value={w ? fmtKg(w.weight_kg) : "—"} sub={w ? fmtDate(w.local_date) : "Not recorded"} />
            </div>
          ) : <Loading />}
          {today?.messages?.length > 0 && <ul className="mt-2 text-sm text-ink-2">{today.messages.map((m: string) => <li key={m}>{m}</li>)}</ul>}
          {canLog(baby.my_role) && <Link href={`/babies/${babyId}/feedings/new`} className="mt-3 flex min-h-12 items-center justify-center rounded-full bg-sage font-bold text-white dark:text-[#10201A]">+ Add feeding for {baby.first_name}</Link>}
        </section>
        <ReferenceCard r={today?.reference} />
        <section className="card p-4">
          <h2 className="mb-2 text-lg font-bold">Coming up</h2>
          <ul className="flex flex-col gap-1 text-sm">
            {appts?.data?.slice(0, 2).map((a: any) => <li key={a.id}><Link className="underline" href={`/babies/${babyId}/appointments/${a.id}`}>📅 {fmtDateTime(a.starts_at, baby.household_timezone)} · {a.purpose.toLowerCase().replace(/_/g, " ")}</Link></li>)}
            {!appts?.data?.length && <li className="text-ink-2">No upcoming appointments.</li>}
            {meds?.data?.map((m: any) => <li key={m.id}>💊 {m.medicine_name} (active)</li>)}
          </ul>
        </section>
        <section className="card p-4">
          <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Recent</h2><Link href={`/babies/${babyId}/timeline`} className="text-sm font-semibold text-sage">Timeline ›</Link></div>
          <ul className="flex flex-col gap-1 text-sm">{tl?.data?.map((e: any) => <li key={e.id}>{fmtDateTime(e.occurred_at, baby.household_timezone)} · {e.title}</li>)}</ul>
        </section>
      </div>
    </>
  );
}
