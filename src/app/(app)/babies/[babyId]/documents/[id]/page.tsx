"use client";
import { use, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, sentence } from "@/lib/format";
import { Button, Card, ErrorState, Loading, Notice, PageHeader, useToast } from "@/components/ui";
import { useBaby, canManage } from "@/components/baby";

/** Document detail (screen 29): in-app viewer via 5-minute signed URL. */
export default function DocumentDetail({ params }: { params: Promise<{ babyId: string; id: string }> }) {
  const { babyId, id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const { data: d, error, reload } = useApi<any>(`/babies/${babyId}/documents/${id}`);
  const [url, setUrl] = useState<{ url: string; mime: string } | null>(null);
  useEffect(() => {
    if (d?.scan_status !== "CLEAN") return;
    api("POST", `/babies/${babyId}/documents/${id}/view-url`, { body: { disposition: "inline" }, idempotent: false }).then((r) => setUrl(r)).catch(() => setUrl(null));
  }, [d?.scan_status, babyId, id]);
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!d || !baby) return <Loading />;
  async function download() {
    try { const r = await api("POST", `/babies/${babyId}/documents/${id}/view-url`, { body: { disposition: "attachment" }, idempotent: false }); window.location.href = r.url; } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function del() {
    if (!confirm("Delete this document? It can be recovered for 30 days by support.")) return;
    try { await api("DELETE", `/babies/${babyId}/documents/${id}`); invalidate(`/babies/${babyId}`); router.push(`/babies/${babyId}/documents`); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title={d.title} back={`/babies/${babyId}/documents`} subtitle={`${sentence(d.doc_type)} · ${d.document_date ? fmtDate(d.document_date) : "undated"}`} />
      <div className="flex flex-col gap-4">
        {d.scan_status !== "CLEAN" && <Notice tone={d.scan_status === "ERROR" || d.scan_status === "PENDING" ? "caution" : "allergy"}>{d.scan_status === "PENDING" || d.scan_status === "ERROR" ? "This file is waiting for its safety scan and can't be opened yet." : `This file was blocked: ${d.scan_detail}`}</Notice>}
        {url && (url.mime.startsWith("image/") ? <img src={url.url} alt={d.title} className="w-full rounded-2xl border border-line" /> : <iframe title={d.title} src={url.url} className="h-[70vh] w-full rounded-2xl border border-line bg-white" />)}
        {d.description && <Card><p className="whitespace-pre-wrap">{d.description}</p></Card>}
        {d.scan_status === "CLEAN" && <Button variant="secondary" onClick={download}>Download</Button>}
        {canManage(baby.my_role) && <Button variant="ghost" onClick={del}>Delete</Button>}
        <p className="text-xs text-ink-2">Viewing links expire after 5 minutes and every view is recorded in the access log.</p>
      </div>
    </>
  );
}
