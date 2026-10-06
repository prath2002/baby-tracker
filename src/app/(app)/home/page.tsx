"use client";
import Link from "next/link";
import { useApi } from "@/lib/useApi";
import { fmtDate, fmtDateTime, fmtKg, fmtMl } from "@/lib/format";
import { Badge, EmptyState, ErrorState, LinkButton, Loading, PageHeader } from "@/components/ui";
import { BabyAvatar, COLOUR, displayName, type Baby } from "@/components/baby";

type HomeBaby = { baby: Baby; today: any; latest_weight: { weight_kg: number; local_date: string } | null; next_vaccine: any; next_appointment: any; alerts: string[] };

/** Home — multi-baby dashboard (screen 5). */
export default function Home() {
  const { data, error, loading, reload } = useApi<{ babies: HomeBaby[] }>("/home", { refreshMs: 60_000 });
  return (
    <>
      <PageHeader title="Today" subtitle={fmtDate(new Date().toISOString().slice(0, 10))} action={<LinkButton href="/babies/new" variant="secondary" className="min-h-10 px-4 text-sm">+ Baby</LinkButton>} />
      {loading && <Loading label="Loading your babies" />}
      {error && <ErrorState message={error.problem.detail ?? error.message} onRetry={reload} />}
      {data && !data.babies.length && <EmptyState icon="🍼" title="Add your first baby" body="Each baby gets their own record, colour and reminders." action={<LinkButton href="/babies/new">Add baby</LinkButton>} />}
      <ul className="flex flex-col gap-4">
        {data?.babies.map(({ baby, today, latest_weight, next_vaccine, next_appointment, alerts }) => {
          const c = COLOUR[baby.colour_token];
          return (
            <li key={baby.id}>
              <article aria-label={`${displayName(baby)}, ${baby.age.display}`} className="card overflow-hidden p-0">
                <div className="h-2" style={{ background: c?.fill }} />
                <Link href={`/babies/${baby.id}`} className="flex items-center gap-3 p-4 pb-2">
                  <BabyAvatar baby={baby} size={56} />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-xl font-extrabold">{displayName(baby)}</h2>
                    <p className="text-ink-2">{baby.age.display}</p>
                  </div>
                  {alerts.includes("ALLERGIES_RECORDED") && <Badge tone="allergy">⚠︎ Allergies</Badge>}
                </Link>
                <dl className="grid grid-cols-3 gap-2 px-4 pb-3 text-center">
                  <div className="rounded-2xl bg-sunken p-2"><dt className="text-[11px] font-semibold uppercase text-ink-2">Feeds</dt><dd className="num text-lg font-extrabold">{today.totalFeedCount}</dd><dd className="text-[11px] text-ink-2">{today.directBreastfeedingSessions} breastfeeds</dd></div>
                  <div className="rounded-2xl bg-sunken p-2"><dt className="text-[11px] font-semibold uppercase text-ink-2">Measured milk</dt><dd className="num text-lg font-extrabold">{today.measuredMl != null ? fmtMl(today.measuredMl) : "—"}</dd><dd className="text-[11px] text-ink-2">{today.dataStatus === "NO_DATA" ? "No feeds yet" : today.lastFeedAt ? `last ${fmtDateTime(today.lastFeedAt, baby.household_timezone).split(", ")[1]}` : ""}</dd></div>
                  <div className="rounded-2xl bg-sunken p-2"><dt className="text-[11px] font-semibold uppercase text-ink-2">Weight</dt><dd className="num text-lg font-extrabold">{latest_weight ? fmtKg(latest_weight.weight_kg) : "—"}</dd><dd className="text-[11px] text-ink-2">{latest_weight ? fmtDate(latest_weight.local_date) : "Not recorded"}</dd></div>
                </dl>
                <div className="flex flex-col gap-1 border-t border-line px-4 py-3 text-sm">
                  <p>💉 {next_vaccine ? <>Next: <b>{next_vaccine.dose_label}</b> · {next_vaccine.status === "UPCOMING" ? `from ${fmtDate(next_vaccine.due_from)}` : next_vaccine.status === "DUE" ? "due now" : "ask your vaccinator"}</> : <span className="text-ink-2">Vaccine schedule pending review — record doses manually</span>}</p>
                  <p>📅 {next_appointment ? <>Next visit: <b>{fmtDateTime(next_appointment.starts_at, baby.household_timezone)}</b></> : <span className="text-ink-2">No upcoming appointments</span>}</p>
                  {alerts.includes("DOCUMENT_BLOCKED") && <p className="font-semibold text-allergy">A document upload was blocked for safety.</p>}
                </div>
                <div className="grid grid-cols-3 gap-2 px-4 pb-4">
                  <Link href={`/babies/${baby.id}/feedings/new`} className="flex min-h-12 items-center justify-center rounded-full bg-sage text-sm font-bold text-white dark:text-[#10201A]">+ Feed</Link>
                  <Link href={`/babies/${baby.id}/weight?add=1`} className="flex min-h-12 items-center justify-center rounded-full border border-line text-sm font-bold">+ Weight</Link>
                  <Link href={`/babies/${baby.id}/milk`} className="flex min-h-12 items-center justify-center rounded-full border border-line text-sm font-bold">Milk</Link>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
      {data && data.babies.length > 1 && <p className="mt-4 text-center text-sm text-ink-2">Tip: the + button always asks which baby you're logging for.</p>}
    </>
  );
}
