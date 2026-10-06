"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtDateTime, fmtKg, sentence } from "@/lib/format";
import { Badge, Button, Card, ErrorState, Field, Loading, PageHeader, Textarea, useToast } from "@/components/ui";
import { AllergyBanner, useBaby, canManage } from "@/components/baby";

/** Appointment detail + visit prep (screen 22). */
export default function AppointmentDetail({ params }: { params: Promise<{ babyId: string; id: string }> }) {
  const { babyId, id } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const { data: a, error, reload } = useApi<any>(`/babies/${babyId}/appointments/${id}`);
  const [after, setAfter] = useState<string | null>(null);
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!a || !baby) return <Loading />;
  async function update(patch: Record<string, unknown>) {
    try { await api("PATCH", `/babies/${babyId}/appointments/${id}`, { body: patch, ifMatch: a.version }); invalidate("/"); reload(); toast({ text: "Appointment updated" }); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  const p = a.visit_prep;
  return (
    <>
      <PageHeader title={sentence(a.purpose)} back={`/babies/${babyId}/appointments`} subtitle={fmtDateTime(a.starts_at, a.tz)} action={<Badge>{a.status.toLowerCase()}</Badge>} />
      <div className="flex flex-col gap-4">
        <Card><dl className="grid grid-cols-2 gap-y-1 text-sm"><dt className="text-ink-2">Doctor</dt><dd>{a.doctor_name ?? "—"}</dd><dt className="text-ink-2">Clinic</dt><dd>{a.clinic_name ?? "—"}</dd></dl>
          {a.notes_before && <><h2 className="mt-3 font-bold">Questions to ask</h2><p className="whitespace-pre-wrap text-sm">{a.notes_before}</p></>}</Card>
        <Card>
          <h2 className="mb-2 text-lg font-bold">Visit prep</h2>
          <p className="mb-2 text-sm text-ink-2">Since {fmtDate(new Date(p.since).toISOString().slice(0, 10))}</p>
          <AllergyBanner baby={baby} />
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            <li>Feeds recorded: {p.feeds.feeds} ({p.feeds.bf_sessions} breastfeeding sessions; measured milk {p.feeds.measured_ml} ml total)</li>
            {p.weights.map((w: any) => <li key={w.local_date}>Measurement {fmtDate(w.local_date)}: {[w.weight_kg && fmtKg(w.weight_kg), w.length_cm && `${w.length_cm} cm`, w.head_circumference_cm && `HC ${w.head_circumference_cm} cm`].filter(Boolean).join(" · ")}</li>)}
            {p.vaccines.map((v: any) => <li key={v.given_on + v.vaccine_name_as_recorded}>Vaccine {fmtDate(v.given_on)}: {v.vaccine_name_as_recorded}</li>)}
            {p.medicines.map((m: any) => <li key={m.medicine_name}>Medicine: {m.medicine_name} ({m.status.toLowerCase()})</li>)}
          </ul>
          <Link href={`/babies/${babyId}/summary/monthly`} className="mt-2 inline-block text-sm font-semibold text-sage">Open summary & PDF ›</Link>
        </Card>
        {canManage(baby.my_role) && (
          <Card className="flex flex-col gap-3">
            <Field label="What the doctor said (notes after visit)" hint="Recorded by you, attributed to the visit.">{(fid, d) => <Textarea id={fid} aria-describedby={d} value={after ?? a.notes_after ?? ""} onChange={(e) => setAfter(e.target.value)} />}</Field>
            <Button variant="secondary" onClick={() => update({ notes_after: after })} disabled={after === null}>Save notes</Button>
            <div className="grid grid-cols-3 gap-2">
              <Button variant="secondary" onClick={() => update({ status: "COMPLETED" })}>Completed</Button>
              <Button variant="secondary" onClick={() => update({ status: "MISSED" })}>Missed</Button>
              <Button variant="secondary" onClick={() => update({ status: "CANCELLED" })}>Cancelled</Button>
            </div>
            <div className="flex gap-2"><Link className="text-sm font-semibold text-sage" href={`/babies/${babyId}/prescriptions/new?appointment=${id}`}>+ Add prescription from this visit</Link></div>
          </Card>
        )}
        {(a.linked.vaccinations.length > 0 || a.linked.prescriptions.length > 0) && <Card><h2 className="mb-1 font-bold">Linked records</h2><ul className="text-sm">{a.linked.prescriptions.map((x: any) => <li key={x.id}><Link className="underline" href={`/babies/${babyId}/prescriptions/${x.id}`}>Prescription {fmtDate(x.prescribed_on)}</Link></li>)}{a.linked.vaccinations.map((x: any) => <li key={x.id}>Vaccine: {x.vaccine_name_as_recorded}</li>)}</ul></Card>}
      </div>
    </>
  );
}
