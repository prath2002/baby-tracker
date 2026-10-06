"use client";
import { Suspense, use, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { todayIn } from "@/lib/format";
import { Button, Card, Field, Input, Loading, Notice, Select, Textarea, useToast } from "@/components/ui";
import { BabyIdentityBar, useBaby, canManage } from "@/components/baby";

/** Add vaccination (screen 18). */
function Inner({ babyId }: { babyId: string }) {
  const sp = useSearchParams();
  const router = useRouter();
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const { data: plan } = useApi<any>(`/babies/${babyId}/vaccinations/plan`);
  const [code, setCode] = useState(sp.get("code") ?? "");
  const [name, setName] = useState(sp.get("name") ?? "");
  const [dose, setDose] = useState(sp.get("dose") ?? "");
  const [date, setDate] = useState("");
  const [by, setBy] = useState("");
  const [lot, setLot] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  if (!baby) return <Loading />;
  if (!canManage(baby.my_role)) return <Notice>Only parents/guardians can record vaccinations.</Notice>;
  const today = todayIn(baby.household_timezone);
  async function save(e?: React.FormEvent, force = false) {
    e?.preventDefault(); setBusy(true); setErr(null);
    try {
      await api("POST", `/babies/${babyId}/vaccinations`, { body: { vaccine_code: code || null, vaccine_name_as_recorded: name, dose_label: dose || null, given_on: date || today, given_by: by || null, lot_number: lot || null, notes: notes || null, force } });
      invalidate(`/babies/${babyId}`); invalidate("/home"); toast({ text: `Vaccine recorded for ${baby!.first_name}` }); router.push(`/babies/${babyId}/vaccinations`);
    } catch (x) { if (x instanceof ApiProblem && x.code === "DUPLICATE_SUSPECTED") setDup(true); setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <>
      <BabyIdentityBar baby={baby} />
      <h1 className="mb-4 text-2xl font-extrabold">Record vaccination</h1>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          {plan?.items && <Field label="From schedule (optional)">{(id) => <Select id={id} value={code} onChange={(e) => { const it = plan.items.find((i: any) => i.code === e.target.value); setCode(e.target.value); if (it) { setName(it.vaccine); setDose(it.dose_label); } }}>
            <option value="">— Other / not in schedule —</option>{plan.items.filter((i: any) => i.status !== "GIVEN").map((i: any) => <option key={i.code} value={i.code}>{i.dose_label} ({i.vaccine})</option>)}</Select>}</Field>}
          <Field label="Vaccine name (as on the card)" required>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
          <Field label="Dose">{(id) => <Input id={id} value={dose} onChange={(e) => setDose(e.target.value)} maxLength={60} />}</Field>
          <Field label="Date given" required>{(id) => <Input id={id} type="date" required min={baby.birth_date} max={today} value={date || today} onChange={(e) => setDate(e.target.value)} />}</Field>
          <Field label="Given by (optional)">{(id) => <Input id={id} value={by} onChange={(e) => setBy(e.target.value)} />}</Field>
          <Field label="Batch / lot number (optional)">{(id) => <Input id={id} value={lot} onChange={(e) => setLot(e.target.value)} />}</Field>
          <Field label="Notes">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        </Card>
        {err && <Notice tone={dup ? "caution" : "allergy"}>{err}</Notice>}
        {dup ? <Button type="button" busy={busy} onClick={() => save(undefined, true)}>Record anyway</Button> : <Button type="submit" busy={busy} disabled={!name}>Mark as given for {baby.first_name}</Button>}
      </form>
    </>
  );
}
export default function AddVaccination({ params }: { params: Promise<{ babyId: string }> }) { const { babyId } = use(params); return <Suspense><Inner babyId={babyId} /></Suspense>; }
