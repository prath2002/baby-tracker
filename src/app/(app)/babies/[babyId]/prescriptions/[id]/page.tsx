"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, todayIn } from "@/lib/format";
import { Button, Card, ErrorState, Field, Input, Loading, Notice, PageHeader, Select, Sheet, useToast } from "@/components/ui";
import { AllergyBanner, useBaby, canManage } from "@/components/baby";

/** Prescription detail (screen 24): verbatim items; create a reminder only with user-confirmed values. */
export default function PrescriptionDetail({ params }: { params: Promise<{ babyId: string; id: string }> }) {
  const { babyId, id } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const { data: p, error, reload } = useApi<any>(`/babies/${babyId}/prescriptions/${id}`);
  const [med, setMed] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!p || !baby) return <Loading />;
  async function createMedicine(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const times = med.times.split(",").map((s: string) => s.trim()).filter(Boolean);
      await api("POST", `/babies/${babyId}/medicines`, { body: { medicine_name: med.name, dose_text_as_prescribed: med.dose, start_date: med.start, end_date: med.end || null, prescription_id: id, doctor_id: p.doctor_id,
        schedule: med.kind === "AS_NEEDED" ? { kind: "AS_NEEDED" } : med.kind === "EVERY_N_HOURS" ? { kind: "EVERY_N_HOURS", every_n_hours: Number(med.hours), anchor_time: times[0] || "08:00" } : { kind: "TIMES_OF_DAY", times_of_day: times } } });
      invalidate(`/babies/${babyId}`); toast({ text: "Medicine reminder created" }); router.push(`/babies/${babyId}/medicines`);
    } catch (x) { toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  async function del() {
    if (!confirm("Delete this prescription?")) return;
    try { await api("DELETE", `/babies/${babyId}/prescriptions/${id}`); invalidate(`/babies/${babyId}`); router.push(`/babies/${babyId}/prescriptions`); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title="Prescription" back={`/babies/${babyId}/prescriptions`} subtitle={`As written by ${p.doctor_name ?? "the doctor"} on ${fmtDate(p.prescribed_on)}`} />
      <div className="flex flex-col gap-4">
        <AllergyBanner baby={baby} />
        {p.diagnosis_text_as_written && <Card><p className="text-sm text-ink-2">Diagnosis as written</p><p>{p.diagnosis_text_as_written}</p></Card>}
        {p.items.map((i: any) => (
          <Card key={i.id}>
            <h2 className="text-lg font-bold">{i.medicine_name}</h2>
            <dl className="mt-1 grid grid-cols-2 gap-y-1 text-sm">{[["Strength", i.strength_text], ["Dose", i.dosage_text], ["How often", i.frequency_text], ["For how long", i.duration_text], ["Route", i.route_text]].filter(([, v]) => v).map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-2">{k}</dt><dd>{v}</dd></div>)}</dl>
            {i.instructions_text && <p className="mt-2 text-sm">{i.instructions_text}</p>}
            {canManage(baby.my_role) && <Button variant="secondary" className="mt-3" onClick={() => setMed({ name: i.medicine_name, dose: [i.strength_text, i.dosage_text].filter(Boolean).join(" "), start: todayIn(baby.household_timezone), end: "", kind: "TIMES_OF_DAY", times: "", hours: "8" })}>Create medicine reminder…</Button>}
          </Card>
        ))}
        <p className="text-xs text-ink-2">Follow your doctor's instructions. This app does not check doses.</p>
        {canManage(baby.my_role) && <Button variant="ghost" onClick={del}>Delete prescription</Button>}
      </div>
      <Sheet open={!!med} onClose={() => setMed(null)} title="Medicine reminder">
        {med && <form onSubmit={createMedicine} className="flex flex-col gap-3">
          <Notice>Check every field against the prescription. Nothing here is calculated.</Notice>
          <Field label="Medicine">{(fid) => <Input id={fid} value={med.name} onChange={(e) => setMed({ ...med, name: e.target.value })} />}</Field>
          <Field label="Dose as prescribed">{(fid) => <Input id={fid} value={med.dose} onChange={(e) => setMed({ ...med, dose: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Start">{(fid) => <Input id={fid} type="date" value={med.start} onChange={(e) => setMed({ ...med, start: e.target.value })} />}</Field><Field label="End (optional)">{(fid) => <Input id={fid} type="date" value={med.end} onChange={(e) => setMed({ ...med, end: e.target.value })} />}</Field></div>
          <Field label="Schedule">{(fid) => <Select id={fid} value={med.kind} onChange={(e) => setMed({ ...med, kind: e.target.value })}><option value="TIMES_OF_DAY">At set times</option><option value="EVERY_N_HOURS">Every N hours</option><option value="AS_NEEDED">As needed (no reminders)</option></Select>}</Field>
          {med.kind !== "AS_NEEDED" && <Field label={med.kind === "TIMES_OF_DAY" ? "Times (HH:MM, comma separated)" : "First dose time (HH:MM)"}>{(fid) => <Input id={fid} placeholder="08:00, 20:00" value={med.times} onChange={(e) => setMed({ ...med, times: e.target.value })} />}</Field>}
          {med.kind === "EVERY_N_HOURS" && <Field label="Every how many hours">{(fid) => <Input id={fid} inputMode="numeric" value={med.hours} onChange={(e) => setMed({ ...med, hours: e.target.value })} />}</Field>}
          <Button type="submit" busy={busy}>Create</Button>
        </form>}
      </Sheet>
    </>
  );
}
