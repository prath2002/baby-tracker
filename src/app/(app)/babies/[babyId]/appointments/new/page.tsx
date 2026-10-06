"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { localInputToIso } from "@/lib/format";
import { Button, Card, Field, Input, Loading, Notice, Select, Textarea, Toggle, useToast } from "@/components/ui";
import { BabyIdentityBar, displayName, useBaby, canManage } from "@/components/baby";
import { DirectoryPicker } from "@/components/directory";

/** Add appointment (screen 21). Siblings seen together get separate per-baby records. */
export default function AddAppointment({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const { data: babies } = useApi<any>("/babies");
  const [f, setF] = useState({ when: "", purpose: "ROUTINE_CHECKUP", doctor: "", clinic: "", notes: "", r1d: true, r2h: true });
  const [siblings, setSiblings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!baby) return <Loading />;
  if (!canManage(baby.my_role)) return <Notice>Only parents/guardians can add appointments.</Notice>;
  const others = (babies?.data ?? []).filter((b: any) => b.id !== babyId && ["OWNER", "GUARDIAN"].includes(b.my_role));
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const r = await api("POST", `/babies/${babyId}/appointments`, { body: { starts_at: localInputToIso(f.when, baby!.household_timezone), tz: baby!.household_timezone, purpose: f.purpose,
        doctor_id: f.doctor || null, clinic_id: f.clinic || null, notes_before: f.notes || null, reminder_offsets_min: [f.r1d && 1440, f.r2h && 120].filter(Boolean), sibling_baby_ids: siblings } });
      invalidate("/"); toast({ text: siblings.length ? `Appointment added for ${siblings.length + 1} babies` : `Appointment added for ${baby!.first_name}` });
      router.push(`/babies/${babyId}/appointments/${r.ids[0]}`);
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <>
      <BabyIdentityBar baby={baby} />
      <h1 className="mb-4 text-2xl font-extrabold">Add appointment</h1>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <Field label="Date & time" required>{(id) => <Input id={id} type="datetime-local" required value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />}</Field>
          <Field label="Purpose">{(id) => <Select id={id} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })}><option value="ROUTINE_CHECKUP">Routine check-up</option><option value="VACCINATION">Vaccination</option><option value="FOLLOW_UP">Follow-up</option><option value="SPECIALIST">Specialist</option><option value="LAB_TEST">Lab test</option><option value="OTHER">Other</option></Select>}</Field>
          <DirectoryPicker householdId={baby.household_id} kind="doctors" value={f.doctor} onChange={(v) => setF({ ...f, doctor: v })} canCreate />
          <DirectoryPicker householdId={baby.household_id} kind="clinics" value={f.clinic} onChange={(v) => setF({ ...f, clinic: v })} canCreate />
          <Field label="Questions to ask">{(id) => <Textarea id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
          <Toggle checked={f.r1d} onChange={(v) => setF({ ...f, r1d: v })} label="Remind me 1 day before" />
          <Toggle checked={f.r2h} onChange={(v) => setF({ ...f, r2h: v })} label="Remind me 2 hours before" />
        </Card>
        {others.length > 0 && <Card><h2 className="mb-1 font-bold">Same visit for siblings?</h2><p className="mb-2 text-sm text-ink-2">Each baby gets their own appointment record.</p>
          {others.map((b: any) => <Toggle key={b.id} checked={siblings.includes(b.id)} onChange={(v) => setSiblings(v ? [...siblings, b.id] : siblings.filter((x) => x !== b.id))} label={displayName(b)} />)}</Card>}
        {err && <Notice tone="allergy">{err}</Notice>}
        <Button type="submit" busy={busy} disabled={!f.when}>Save appointment</Button>
      </form>
    </>
  );
}
