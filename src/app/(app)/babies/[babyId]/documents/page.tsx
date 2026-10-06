"use client";
import { use, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate, sentence } from "@/lib/format";
import { Badge, EmptyState, ErrorState, Input, LinkButton, ListRow, Loading, Notice, PageHeader } from "@/components/ui";
import { BabyNav, displayName, useBaby, canManage } from "@/components/baby";

const SCAN: Record<string, ["success" | "caution" | "allergy" | "neutral", string]> = { CLEAN: ["success", "Ready"], PENDING: ["neutral", "Checking…"], INFECTED: ["allergy", "Blocked"], REJECTED: ["allergy", "Rejected"], ERROR: ["caution", "Scan pending"] };

/** Medical documents (screen 27). */
export default function Documents({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby } = useBaby(babyId);
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useApi<any>(baby?.can_view_documents ? `/babies/${babyId}/documents${q ? `?q=${encodeURIComponent(q)}` : ""}` : null);
  if (!baby) return <Loading />;
  return (
    <>
      <PageHeader title="Medical documents" subtitle={displayName(baby)} action={canManage(baby.my_role) && <LinkButton href={`/babies/${babyId}/documents/upload`} className="min-h-10 px-4 text-sm">+ Upload</LinkButton>} />
      <BabyNav babyId={babyId} active="documents" />
      {!baby.can_view_documents ? <Notice>Document access hasn't been granted for your role.</Notice> : (<>
        <div className="mb-3"><Input aria-label="Search documents" placeholder="Search by title" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {loading && <Loading />}
        {error && <ErrorState message={error.message} onRetry={reload} />}
        {data && !data.data.length && <EmptyState icon="📄" title="No documents yet" body="Lab reports, discharge summaries and vaccination cards are stored privately." action={canManage(baby.my_role) && <LinkButton href={`/babies/${babyId}/documents/upload`}>Upload document</LinkButton>} />}
        <ul className="card divide-y divide-line p-1">{data?.data.map((d: any) => <li key={d.id}><ListRow href={`/babies/${babyId}/documents/${d.id}`} title={d.title} sub={`${sentence(d.doc_type)} · ${d.document_date ? fmtDate(d.document_date) : "undated"}${d.tags?.length ? ` · ${d.tags.join(", ")}` : ""}`} right={<Badge tone={SCAN[d.scan_status][0]}>{SCAN[d.scan_status][1]}</Badge>} /></li>)}</ul>
      </>)}
    </>
  );
}
