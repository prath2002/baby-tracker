"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { Badge, Card, ErrorState, LinkButton, Loading, Notice, PageHeader, Segmented, Toggle, useToast } from "@/components/ui";
import { BabyNav, displayName, useBaby, canManage } from "@/components/baby";
import { SourceChip } from "@/components/reference";

const TONE: Record<string, "success" | "info" | "caution" | "neutral"> = { GIVEN: "success", DUE: "info", PAST_STATED_AGE_LIMIT: "caution", UPCOMING: "neutral", NOT_APPLICABLE: "neutral" };
const TXT: Record<string, string> = { GIVEN: "Given", DUE: "Due now", PAST_STATED_AGE_LIMIT: "Ask your vaccinator", UPCOMING: "Upcoming", NOT_APPLICABLE: "Not applicable" };

/** Vaccination dashboard (screen 17). */
export default function Vaccinations({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby, reload: reloadBaby } = useBaby(babyId);
  const { data: plan, error, loading, reload } = useApi<any>(`/babies/${babyId}/vaccinations/plan`);
  const { data: given } = useApi<any>(`/babies/${babyId}/vaccinations`);
  const [busy, setBusy] = useState(false);
  if (!baby) return <Loading />;
  async function setSchedule(schedule_id: string, je_opt_in: boolean) {
    setBusy(true);
    try { await api("PUT", `/babies/${babyId}/schedule-selection`, { body: { schedule_id, je_opt_in } }); invalidate(`/babies/${babyId}`); reload(); reloadBaby(); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  const sched = baby.schedule ?? { schedule_id: "GOVERNMENT_OF_INDIA_UIP", je_opt_in: false };
  return (
    <>
      <PageHeader title="Vaccinations" subtitle={displayName(baby)} action={canManage(baby.my_role) && <LinkButton href={`/babies/${babyId}/vaccinations/new`} className="min-h-10 px-4 text-sm">+ Record</LinkButton>} />
      <BabyNav babyId={babyId} active="vaccinations" />
      <div className="flex flex-col gap-4">
        {canManage(baby.my_role) && <Card className="flex flex-col gap-2">
          <Segmented label="Schedule" value={sched.schedule_id} onChange={(v) => setSchedule(v, sched.je_opt_in)} options={[{ value: "GOVERNMENT_OF_INDIA_UIP", label: "Government (UIP)" }, { value: "IAP_RECOMMENDED_SCHEDULE", label: "IAP" }]} />
          {sched.schedule_id === "GOVERNMENT_OF_INDIA_UIP" && <Toggle checked={sched.je_opt_in} onChange={(v) => setSchedule(sched.schedule_id, v)} label="My district offers JE vaccine" description="Japanese Encephalitis vaccine is given only in endemic districts — ask your health worker." />}
          <p className="text-xs text-ink-2">Schedules are kept separate and versioned; doses already given are never changed. {busy && "Saving…"}</p>
        </Card>}
        {loading && <Loading />}
        {error && (error.code === "SCHEDULE_NOT_RELEASED" ? <Notice tone="caution" title="Schedule pending clinical verification">Due dates will appear once our reviewers have verified this schedule against the current official source. You can record vaccines given at any time.</Notice> : <ErrorState message={error.message} onRetry={reload} />)}
        {plan && (<>
          {plan.pendingReview > 0 && <Notice tone="caution">{plan.pendingReview} schedule item(s) are pending verification and not shown.</Notice>}
          <ul className="flex flex-col gap-2">
            {plan.items.map((i: any) => (
              <li key={i.code} className="card flex flex-col gap-1 p-3">
                <div className="flex items-center justify-between gap-2"><p className="font-bold">{i.dose_label} <span className="font-normal text-ink-2">· {i.vaccine}</span></p><Badge tone={TONE[i.status]}>{TXT[i.status]}</Badge></div>
                <p className="text-sm text-ink-2">{i.status === "GIVEN" ? `Given ${fmtDate(i.given_on)}` : `From ${fmtDate(i.due_from)}${i.due_to ? ` to ${fmtDate(i.due_to)}` : ""}`}</p>
                {i.conflict && <p className="text-sm text-caution">⚠︎ {i.conflict}</p>}
                {i.notes.map((n: string) => <p key={n} className="text-sm">{n}</p>)}
                <div className="flex items-center gap-2">
                  <SourceChip provenance={i.provenance} />{i.preview && <Badge tone="caution">unverified</Badge>}
                  {i.status !== "GIVEN" && i.status !== "NOT_APPLICABLE" && canManage(baby.my_role) && <Link className="ml-auto text-sm font-semibold text-sage" href={`/babies/${babyId}/vaccinations/new?code=${i.code}&name=${encodeURIComponent(i.vaccine)}&dose=${encodeURIComponent(i.dose_label)}`}>Mark given</Link>}
                </div>
              </li>
            ))}
          </ul>
        </>)}
        <Card>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Recorded doses</h2><Link href={`/babies/${babyId}/vaccinations/timeline`} className="text-sm font-semibold text-sage">Timeline ›</Link></div>
          {given?.data?.length ? <ul className="text-sm">{given.data.map((v: any) => <li key={v.id}>{fmtDate(v.given_on)} · {v.vaccine_name_as_recorded}{v.dose_label ? ` (${v.dose_label})` : ""}</li>)}</ul> : <p className="text-sm text-ink-2">No vaccinations recorded.</p>}
        </Card>
        <p className="text-xs text-ink-2">Schedules change; your vaccinator or pediatrician is the authority. This app does not give vaccination advice.</p>
      </div>
    </>
  );
}
