"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate } from "@/lib/useApi";
import { Button, Card, Field, Input, Loading, Notice, Select, Textarea, useToast } from "@/components/ui";
import { BabyIdentityBar, useBaby, canManage } from "@/components/baby";

const TYPES = [["LAB_REPORT", "Lab report"], ["IMAGING", "Imaging"], ["DISCHARGE_SUMMARY", "Discharge summary"], ["PRESCRIPTION_SCAN", "Prescription"], ["VACCINATION_CARD", "Vaccination card"], ["BIRTH_RECORD", "Birth record"], ["INSURANCE", "Insurance"], ["OTHER", "Other"]];
const ALLOWED = ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];

/** Upload document (screen 28): presigned upload to quarantine → server-side validation + malware scan. */
export default function Upload({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [file, setFile] = useState<File | null>(null);
  const [m, setM] = useState({ title: "", doc_type: "LAB_REPORT", document_date: "", description: "", tags: "" });
  const [stage, setStage] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!baby) return <Loading />;
  if (!canManage(baby.my_role)) return <Notice>Only parents/guardians can upload documents.</Notice>;
  const pick = (f: File | null) => {
    setErr(null);
    if (!f) return setFile(null);
    if (!ALLOWED.includes(f.type)) { setErr("Please choose a PDF, JPG, PNG, WebP or HEIC file."); return; }
    if (f.size > 20 * 1024 * 1024) { setErr("Files can be up to 20 MB."); return; }
    setFile(f); if (!m.title) setM((x) => ({ ...x, title: f.name.replace(/\.[^.]+$/, "").slice(0, 160) }));
  };
  async function upload(e: React.FormEvent) {
    e.preventDefault(); if (!file) return; setErr(null);
    try {
      setStage("Preparing…");
      const intent = await api("POST", `/babies/${babyId}/documents/upload-intents`, { body: { title: m.title, doc_type: m.doc_type, document_date: m.document_date || null, description: m.description || null,
        tags: m.tags.split(",").map((t) => t.trim()).filter(Boolean), file_name: file.name, declared_mime: file.type, size_bytes: file.size } });
      setStage("Uploading securely…");
      const put = await fetch(intent.upload_url, { method: "PUT", headers: intent.required_headers, body: file });
      if (!put.ok) throw new Error("Upload failed");
      setStage("Scanning for safety…");
      const done = await api("POST", `/babies/${babyId}/documents/${intent.document_id}/complete`, { idempotent: false });
      invalidate(`/babies/${babyId}`);
      if (done.scan_status === "CLEAN") { toast({ text: "Document added" }); router.push(`/babies/${babyId}/documents/${intent.document_id}`); }
      else if (done.scan_status === "ERROR") { toast({ text: "Uploaded — the safety scan will finish shortly" }); router.push(`/babies/${babyId}/documents`); }
      else { setErr(`File blocked for safety: ${done.scan_detail ?? "it failed validation"}`); setStage(null); }
    } catch (x) { setErr(x instanceof Error && !(x as any).problem ? "Upload failed. Check your connection and try again." : errorText(x)); setStage(null); }
  }
  return (
    <>
      <BabyIdentityBar baby={baby} />
      <h1 className="mb-4 text-2xl font-extrabold">Upload document</h1>
      <form onSubmit={upload} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <Field label="File" hint="PDF, JPG, PNG, WebP or HEIC · up to 20 MB · location data is removed from photos">{(id, d) => <input id={id} aria-describedby={d} type="file" accept={ALLOWED.join(",")} capture="environment" onChange={(e) => pick(e.target.files?.[0] ?? null)} className="block min-h-12 w-full text-sm file:mr-3 file:min-h-12 file:rounded-full file:border-0 file:bg-sage-soft file:px-4 file:font-semibold" />}</Field>
          <Field label="Title" required>{(id) => <Input id={id} required maxLength={160} value={m.title} onChange={(e) => setM({ ...m, title: e.target.value })} />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={m.doc_type} onChange={(e) => setM({ ...m, doc_type: e.target.value })}>{TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>}</Field>
          <Field label="Document date">{(id) => <Input id={id} type="date" value={m.document_date} onChange={(e) => setM({ ...m, document_date: e.target.value })} />}</Field>
          <Field label="Description">{(id) => <Textarea id={id} value={m.description} onChange={(e) => setM({ ...m, description: e.target.value })} />}</Field>
          <Field label="Tags (comma separated)">{(id) => <Input id={id} value={m.tags} onChange={(e) => setM({ ...m, tags: e.target.value })} />}</Field>
        </Card>
        {stage && <p role="status" className="text-center font-semibold text-sage">{stage}</p>}
        {err && <Notice tone="allergy">{err}</Notice>}
        <Button type="submit" busy={!!stage} disabled={!file || !m.title}>Upload for {baby.first_name}</Button>
      </form>
    </>
  );
}
