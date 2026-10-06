"use client";
import { useApi } from "@/lib/useApi";
import { Badge, Card, Loading, PageHeader } from "@/components/ui";

/** Source registry (spec §42) — transparency about where reference information comes from. */
export default function Sources() {
  const { data } = useApi<any[]>("/references/sources");
  const { data: unsupported } = useApi<any[]>("/references/unsupported");
  const { data: status } = useApi<any[]>("/references/status");
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title="Medical sources" back="/settings" />
      <p className="mb-3 text-sm text-ink-2">Reference information in this app is shown only after clinical reviewers verify it against these sources. Values pending verification are not shown.</p>
      <ul className="flex flex-col gap-2">{data.map((s) => (
        <li key={s.source_id}><Card>
          <p className="font-bold">{s.document_title}</p>
          <p className="text-sm">{s.organization} · {s.publication_date}</p>
          <div className="mt-1 flex flex-wrap gap-1"><Badge tone="info">{s.tier.replace(/_/g, " ").toLowerCase()}</Badge><Badge tone={s.verification_status.startsWith("VERIFIED") ? "success" : "caution"}>{s.verification_status.split("__")[0].replace(/_/g, " ").toLowerCase()}</Badge></div>
          <a className="mt-1 block break-all text-xs text-info underline" href={s.source_url} target="_blank" rel="noopener noreferrer">{s.source_url}</a>
        </Card></li>))}</ul>
      {status && <Card className="mt-4"><h2 className="mb-1 font-bold">Release status</h2><ul className="text-sm">{status.map((r: any) => <li key={r.bucket + r.release_gate}>{r.bucket.replace(/_/g, " ")}: {r.n} × {r.release_gate.replace(/_/g, " ").toLowerCase()}</li>)}</ul></Card>}
      {unsupported && <Card className="mt-4"><h2 className="mb-1 font-bold">Not established — never shown as numbers</h2><ul className="list-disc pl-5 text-sm">{unsupported.map((u) => <li key={u.id}>{u.claim} <span className="text-ink-2">({u.status.toLowerCase().replace(/_/g, " ")})</span></li>)}</ul></Card>}
    </>
  );
}
