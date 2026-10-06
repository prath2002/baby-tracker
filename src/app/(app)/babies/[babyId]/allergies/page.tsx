"use client";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, PageHeader, Segmented, Select, Sheet, Textarea, useToast } from "@/components/ui";
import { AllergyBanner, BabyNav, displayName, useBaby, canManage } from "@/components/baby";

/** Allergy management (screen 26). Severity is as reported, not assessed by the app. */
export default function Allergies({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby, reload: reloadBaby } = useBaby(babyId);
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/allergies`);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!baby) return <Loading />;
  const refresh = () => { invalidate(`/babies/${babyId}`); invalidate("/home"); reload(); reloadBaby(); };
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const body = { substance: f.substance, category: f.category || null, reaction_text: f.reaction || null, severity_reported: f.severity, status: f.status, discovered_on: f.discovered || null, notes: f.notes || null };
    try { if (f.id) await api("PATCH", `/babies/${babyId}/allergies/${f.id}`, { body, ifMatch: f.version }); else await api("POST", `/babies/${babyId}/allergies`, { body }); setF(null); refresh(); toast({ text: "Allergy saved" }); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  async function deactivate(a: any) { try { await api("PATCH", `/babies/${babyId}/allergies/${a.id}`, { body: { is_active: !a.is_active }, ifMatch: a.version }); refresh(); } catch (x) { toast({ text: errorText(x), tone: "error" }); } }
  async function confirmNone() { try { await api("POST", `/babies/${babyId}/allergies/confirm-none`); refresh(); toast({ text: "Recorded: no known allergies" }); } catch (x) { toast({ text: errorText(x), tone: "error" }); } }
  return (
    <>
      <PageHeader title="Allergies" subtitle={displayName(baby)} action={canManage(baby.my_role) && <Button className="min-h-10 px-4 text-sm" onClick={() => setF({ substance: "", category: "", reaction: "", severity: "UNKNOWN", status: "SUSPECTED", discovered: "", notes: "" })}>+ Add</Button>} />
      <BabyNav babyId={babyId} active="allergies" />
      <div className="flex flex-col gap-3">
        <AllergyBanner baby={baby} />
        {loading && <Loading />}
        {error && <ErrorState message={error.message} onRetry={reload} />}
        {data && !data.data.length && <EmptyState icon="⚕︎" title="No allergies recorded" body="'No allergies recorded' is different from 'No known allergies'." action={canManage(baby.my_role) && !data.nka_confirmed_at && <Button variant="secondary" onClick={confirmNone}>Confirm no known allergies</Button>} />}
        {data?.data.map((a: any) => (
          <Card key={a.id} className={a.is_active ? "" : "opacity-60"}>
            <div className="flex items-start justify-between gap-2"><h2 className="text-lg font-bold">{a.substance}</h2><Badge tone={a.status === "CONFIRMED_BY_DOCTOR" ? "allergy" : "caution"}>{a.status === "CONFIRMED_BY_DOCTOR" ? "Confirmed by doctor" : "Suspected"}</Badge></div>
            <p className="text-sm">Reaction: {a.reaction_text ?? "—"} · Severity reported: {a.severity_reported.toLowerCase()}</p>
            {a.discovered_on && <p className="text-sm text-ink-2">Noticed {fmtDate(a.discovered_on)}</p>}
            {canManage(baby.my_role) && <div className="mt-2 flex gap-2"><Button variant="secondary" className="min-h-10 text-sm" onClick={() => setF({ id: a.id, version: a.version, substance: a.substance, category: a.category ?? "", reaction: a.reaction_text ?? "", severity: a.severity_reported, status: a.status, discovered: a.discovered_on ?? "", notes: a.notes ?? "" })}>Edit</Button><Button variant="ghost" className="min-h-10 text-sm" onClick={() => deactivate(a)}>{a.is_active ? "Mark inactive" : "Reactivate"}</Button></div>}
          </Card>
        ))}
      </div>
      <Sheet open={!!f} onClose={() => setF(null)} title={f?.id ? "Edit allergy" : "Add allergy"}>
        {f && <form onSubmit={save} className="flex flex-col gap-3">
          <Field label="Substance" required>{(id) => <Input id={id} required value={f.substance} onChange={(e) => setF({ ...f, substance: e.target.value })} />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">—</option><option value="FOOD">Food</option><option value="DRUG">Medicine</option><option value="ENVIRONMENTAL">Environmental</option><option value="OTHER">Other</option></Select>}</Field>
          <Field label="Reaction">{(id) => <Textarea id={id} value={f.reaction} onChange={(e) => setF({ ...f, reaction: e.target.value })} />}</Field>
          <div><p className="mb-1.5 text-sm font-semibold">Severity (as reported)</p><Segmented label="Severity" value={f.severity} onChange={(v) => setF({ ...f, severity: v })} options={[{ value: "MILD", label: "Mild" }, { value: "MODERATE", label: "Moderate" }, { value: "SEVERE", label: "Severe" }, { value: "UNKNOWN", label: "Unknown" }]} /></div>
          <div><p className="mb-1.5 text-sm font-semibold">Status</p><Segmented label="Status" value={f.status} onChange={(v) => setF({ ...f, status: v })} options={[{ value: "SUSPECTED", label: "Suspected" }, { value: "CONFIRMED_BY_DOCTOR", label: "Confirmed by doctor" }]} /></div>
          <Field label="Noticed on">{(id) => <Input id={id} type="date" value={f.discovered} onChange={(e) => setF({ ...f, discovered: e.target.value })} />}</Field>
          <Field label="Notes">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
          <Button type="submit" busy={busy} disabled={!f.substance}>Save</Button>
        </form>}
      </Sheet>
    </>
  );
}
