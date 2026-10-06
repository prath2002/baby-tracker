"use client";
import { use, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDateTime, sentence } from "@/lib/format";
import { Badge, EmptyState, ErrorState, LinkButton, ListRow, Loading, PageHeader, Segmented } from "@/components/ui";
import { BabyNav, displayName, useBaby, canManage } from "@/components/baby";

/** Doctor appointments (screen 20). */
export default function Appointments({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby } = useBaby(babyId);
  const [tab, setTab] = useState<"UP" | "PAST">("UP");
  const now = new Date().toISOString();
  const { data, error, loading, reload } = useApi<any>(tab === "UP" ? `/appointments?baby_id=${babyId}&from=${now.slice(0, 13)}:00:00Z` : `/appointments?baby_id=${babyId}&to=${now.slice(0, 13)}:00:00Z&sort=-starts_at`);
  if (!baby) return <Loading />;
  return (
    <>
      <PageHeader title="Appointments" subtitle={displayName(baby)} action={canManage(baby.my_role) && <LinkButton href={`/babies/${babyId}/appointments/new`} className="min-h-10 px-4 text-sm">+ Add</LinkButton>} />
      <BabyNav babyId={babyId} active="appointments" />
      <div className="mb-3"><Segmented label="Show" value={tab} onChange={setTab} options={[{ value: "UP", label: "Upcoming" }, { value: "PAST", label: "Past" }]} /></div>
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.data.length && <EmptyState icon="📅" title={tab === "UP" ? "No upcoming appointments" : "No past appointments"} action={canManage(baby.my_role) && tab === "UP" && <LinkButton href={`/babies/${babyId}/appointments/new`}>Add appointment</LinkButton>} />}
      <ul className="card divide-y divide-line p-1">{data?.data.map((a: any) => <li key={a.id}><ListRow href={`/babies/${babyId}/appointments/${a.id}`} title={sentence(a.purpose)} sub={`${fmtDateTime(a.starts_at, a.tz)}${a.doctor_name ? ` · ${a.doctor_name}` : ""}${a.clinic_name ? ` · ${a.clinic_name}` : ""}`} right={a.status !== "SCHEDULED" && <Badge>{a.status.toLowerCase()}</Badge>} /></li>)}</ul>
    </>
  );
}
