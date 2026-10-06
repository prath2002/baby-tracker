"use client";
import { use } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { EmptyState, ErrorState, LinkButton, ListRow, Loading, PageHeader } from "@/components/ui";
import { AllergyBanner, BabyNav, displayName, useBaby, canManage } from "@/components/baby";

/** Prescriptions (screen 23). */
export default function Prescriptions({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby } = useBaby(babyId);
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/prescriptions`);
  if (!baby) return <Loading />;
  return (
    <>
      <PageHeader title="Prescriptions" subtitle={displayName(baby)} action={canManage(baby.my_role) && <LinkButton href={`/babies/${babyId}/prescriptions/new`} className="min-h-10 px-4 text-sm">+ Add</LinkButton>} />
      <BabyNav babyId={babyId} active="prescriptions" />
      <div className="mb-3"><AllergyBanner baby={baby} /></div>
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.data.length && <EmptyState icon="📝" title="No prescriptions" body="Record prescriptions exactly as your doctor wrote them." />}
      <ul className="card divide-y divide-line p-1">{data?.data.map((p: any) => <li key={p.id}><ListRow href={`/babies/${babyId}/prescriptions/${p.id}`} title={p.items.map((i: any) => i.medicine_name).join(", ") || "Prescription"} sub={`${fmtDate(p.prescribed_on)}${p.doctor_name ? ` · Dr ${p.doctor_name.replace(/^Dr\.?\s*/i, "")}` : ""}`} /></li>)}</ul>
    </>
  );
}
