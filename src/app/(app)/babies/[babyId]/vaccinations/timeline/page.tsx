"use client";
import { use } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { Loading, Notice, PageHeader } from "@/components/ui";
import { BabyNav, displayName, useBaby } from "@/components/baby";

/** Vaccination timeline (screen 19): given doses and future items on an age axis. */
export default function VaccineTimeline({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby } = useBaby(babyId);
  const { data: plan, error } = useApi<any>(`/babies/${babyId}/vaccinations/plan`);
  const { data: given } = useApi<any>(`/babies/${babyId}/vaccinations`);
  if (!baby) return <Loading />;
  const items = [
    ...(given?.data ?? []).map((v: any) => ({ date: v.given_on, label: `${v.vaccine_name_as_recorded}${v.dose_label ? ` · ${v.dose_label}` : ""}`, given: true })),
    ...(plan?.items ?? []).filter((i: any) => i.status !== "GIVEN" && i.status !== "NOT_APPLICABLE").map((i: any) => ({ date: i.due_from, label: `${i.dose_label} · ${i.vaccine}`, given: false })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <>
      <PageHeader title="Vaccination timeline" subtitle={displayName(baby)} back={`/babies/${babyId}/vaccinations`} />
      <BabyNav babyId={babyId} active="vaccinations" />
      {error && <Notice tone="caution">Schedule pending verification — only recorded doses are shown.</Notice>}
      <ol className="relative ml-3 mt-3 border-l-2 border-line">
        {items.map((it, i) => (
          <li key={i} className="mb-4 ml-4">
            <span aria-hidden className={`absolute -left-[9px] mt-1.5 h-4 w-4 rounded-full border-2 ${it.given ? "border-sage bg-sage" : "border-line bg-surface"}`} />
            <p className={`font-semibold ${it.given ? "" : "text-ink-2"}`}>{it.label}</p>
            <p className="text-sm text-ink-2">{it.given ? "Given" : "From"} {fmtDate(it.date)}</p>
          </li>
        ))}
        {!items.length && <li className="ml-4 text-ink-2">Nothing yet.</li>}
      </ol>
    </>
  );
}
