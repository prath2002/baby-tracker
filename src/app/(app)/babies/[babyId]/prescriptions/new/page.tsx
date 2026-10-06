"use client";
import { Suspense, use, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate } from "@/lib/useApi";
import { todayIn } from "@/lib/format";
import { Button, Card, Field, Input, Loading, Notice, Textarea, useToast } from "@/components/ui";
import { AllergyBanner, BabyIdentityBar, useBaby, canManage } from "@/components/baby";
import { DirectoryPicker } from "@/components/directory";

type Item = { medicine_name: string; strength_text: string; dosage_text: string; frequency_text: string; duration_text: string; instructions_text: string };
const blank = (): Item => ({ medicine_name: "", strength_text: "", dosage_text: "", frequency_text: "", duration_text: "", instructions_text: "" });

/** Add prescription — verbatim, never inferred (spec §27). */
function Inner({ babyId }: { babyId: string }) {
  const router = useRouter();
  const appointment = useSearchParams().get("appointment");
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [date, setDate] = useState("");
  const [doctor, setDoctor] = useState("");
  const [dx, setDx] = useState("");
  const [items, setItems] = useState<Item[]>([blank()]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!baby) return <Loading />;
  if (!canManage(baby.my_role)) return <Notice>Only parents/guardians can add prescriptions.</Notice>;
  const set = (i: number, k: keyof Item, v: string) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api("POST", `/babies/${babyId}/prescriptions`, { body: { prescribed_on: date || todayIn(baby!.household_timezone), doctor_id: doctor || null, appointment_id: appointment, diagnosis_text_as_written: dx || null,
        items: items.filter((i) => i.medicine_name).map((i) => Object.fromEntries(Object.entries(i).map(([k, v]) => [k, v || null]))) } });
      invalidate(`/babies/${babyId}`); toast({ text: "Prescription saved" }); router.push(`/babies/${babyId}/prescriptions/${r.id}`);
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <>
      <BabyIdentityBar baby={baby} />
      <h1 className="mb-2 text-2xl font-extrabold">Add prescription</h1>
      <div className="mb-3"><AllergyBanner baby={baby} /></div>
      <Notice>Copy each item exactly as written by the doctor. This app never suggests, calculates or checks doses.</Notice>
      <form onSubmit={save} className="mt-4 flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <Field label="Date on prescription">{(id) => <Input id={id} type="date" max={todayIn(baby.household_timezone)} value={date || todayIn(baby.household_timezone)} onChange={(e) => setDate(e.target.value)} />}</Field>
          <DirectoryPicker householdId={baby.household_id} kind="doctors" value={doctor} onChange={setDoctor} canCreate />
          <Field label="Diagnosis as written (optional)">{(id) => <Input id={id} value={dx} onChange={(e) => setDx(e.target.value)} />}</Field>
        </Card>
        {items.map((it, i) => (
          <Card key={i} className="flex flex-col gap-3">
            <h2 className="font-bold">Item {i + 1}</h2>
            <Field label="Medicine (as written)" required>{(id) => <Input id={id} value={it.medicine_name} onChange={(e) => set(i, "medicine_name", e.target.value)} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Strength">{(id) => <Input id={id} value={it.strength_text} onChange={(e) => set(i, "strength_text", e.target.value)} />}</Field>
              <Field label="Dose">{(id) => <Input id={id} value={it.dosage_text} onChange={(e) => set(i, "dosage_text", e.target.value)} />}</Field>
              <Field label="How often">{(id) => <Input id={id} value={it.frequency_text} onChange={(e) => set(i, "frequency_text", e.target.value)} />}</Field>
              <Field label="For how long">{(id) => <Input id={id} value={it.duration_text} onChange={(e) => set(i, "duration_text", e.target.value)} />}</Field>
            </div>
            <Field label="Instructions">{(id) => <Textarea id={id} value={it.instructions_text} onChange={(e) => set(i, "instructions_text", e.target.value)} />}</Field>
            {items.length > 1 && <Button type="button" variant="ghost" onClick={() => setItems(items.filter((_, j) => j !== i))}>Remove item</Button>}
          </Card>
        ))}
        <Button type="button" variant="secondary" onClick={() => setItems([...items, blank()])}>+ Add another item</Button>
        {err && <Notice tone="allergy">{err}</Notice>}
        <Button type="submit" busy={busy}>Save prescription</Button>
      </form>
    </>
  );
}
export default function AddPrescription({ params }: { params: Promise<{ babyId: string }> }) { const { babyId } = use(params); return <Suspense><Inner babyId={babyId} /></Suspense>; }
