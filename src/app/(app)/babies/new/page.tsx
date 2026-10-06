"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText, fieldErrors } from "@/lib/api";
import { invalidate } from "@/lib/useApi";
import { Button, Card, Field, Input, Notice, PageHeader, Segmented, Select, Toggle } from "@/components/ui";

/** Add Baby (screen 6). */
function AddBabyInner() {
  const router = useRouter();
  const first = useSearchParams().get("first") === "1";
  const [f, setF] = useState({ first_name: "", nickname: "", sex: "NOT_STATED", birth_date: "", birth_time: "", birth_tz: "Asia/Kolkata", birth_weight: "", weight_unit: "kg", birth_length_cm: "", birth_hc_cm: "", ga_weeks: "", ga_days: "", ga_unknown: false, schedule_id: "GOVERNMENT_OF_INDIA_UIP", unable_to_breastfeed: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [confirmWeight, setConfirmWeight] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const today = new Date().toISOString().slice(0, 10);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null); setFe({});
    const bw = f.birth_weight ? Number(f.birth_weight) / (f.weight_unit === "g" ? 1000 : 1) : null;
    try {
      const b = await api("POST", "/babies", { body: {
        first_name: f.first_name, nickname: f.nickname || null, sex: f.sex, birth_date: f.birth_date, birth_time: f.birth_time || null, birth_tz: f.birth_tz,
        birth_weight_kg: bw, birth_length_cm: f.birth_length_cm ? Number(f.birth_length_cm) : null, birth_hc_cm: f.birth_hc_cm ? Number(f.birth_hc_cm) : null,
        ga_weeks: f.ga_unknown || !f.ga_weeks ? null : Number(f.ga_weeks), ga_days: f.ga_unknown || !f.ga_weeks ? null : Number(f.ga_days || 0), ga_unknown: f.ga_unknown,
        schedule_id: f.schedule_id, unable_to_breastfeed: f.unable_to_breastfeed || null, confirm_weight: confirmWeight } });
      invalidate("/"); router.replace(`/babies/${b.id}?added=1`);
    } catch (x) {
      if (x instanceof ApiProblem && x.code === "CONFIRMATION_REQUIRED") setConfirmWeight(true);
      setErr(errorText(x)); setFe(fieldErrors(x));
    } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title={first ? "Add your baby" : "Add a baby"} back={first ? undefined : "/home"} />
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Card className="flex flex-col gap-4">
          <Field label="First name" required error={fe.first_name}>{(id, d) => <Input id={id} aria-describedby={d} required maxLength={60} value={f.first_name} onChange={(e) => set("first_name", e.target.value)} />}</Field>
          <Field label="Nickname or distinguisher" hint="Helps tell twins or siblings apart, e.g. 'Twin A'.">{(id, d) => <Input id={id} aria-describedby={d} maxLength={40} value={f.nickname} onChange={(e) => set("nickname", e.target.value)} />}</Field>
          <div><p className="mb-1.5 text-sm font-semibold">Sex</p><Segmented label="Sex" value={f.sex} onChange={(v) => set("sex", v)} options={[{ value: "FEMALE", label: "Girl" }, { value: "MALE", label: "Boy" }, { value: "NOT_STATED", label: "Not stated" }]} />
            {f.sex === "NOT_STATED" && <p className="mt-1 text-sm text-ink-2">WHO growth references are sex-specific, so growth charts won't be available until this is set.</p>}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date of birth" required error={fe.birth_date}>{(id, d) => <Input id={id} aria-describedby={d} type="date" required max={today} value={f.birth_date} onChange={(e) => set("birth_date", e.target.value)} />}</Field>
            <Field label="Time of birth" hint="Optional" error={fe.birth_time}>{(id, d) => <Input id={id} aria-describedby={d} type="time" value={f.birth_time} onChange={(e) => set("birth_time", e.target.value)} />}</Field>
          </div>
          <Field label="Place of birth timezone">{(id) => <Select id={id} value={f.birth_tz} onChange={(e) => set("birth_tz", e.target.value)}>{["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"].map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
        </Card>
        <Card className="flex flex-col gap-4">
          <h2 className="font-bold">Birth details (optional)</h2>
          <div className="grid grid-cols-[1fr_auto] gap-3">
            <Field label="Birth weight" error={fe.birth_weight_kg}>{(id) => <Input id={id} inputMode="decimal" value={f.birth_weight} onChange={(e) => set("birth_weight", e.target.value)} />}</Field>
            <div className="pt-7"><Segmented label="Weight unit" value={f.weight_unit} onChange={(v) => set("weight_unit", v)} options={[{ value: "kg", label: "kg" }, { value: "g", label: "g" }]} /></div>
          </div>
          {confirmWeight && <Notice tone="caution">That weight looks unusual. Check the unit, then press Save again to confirm.</Notice>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Length (cm)">{(id) => <Input id={id} inputMode="decimal" value={f.birth_length_cm} onChange={(e) => set("birth_length_cm", e.target.value)} />}</Field>
            <Field label="Head (cm)">{(id) => <Input id={id} inputMode="decimal" value={f.birth_hc_cm} onChange={(e) => set("birth_hc_cm", e.target.value)} />}</Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gestational age (weeks)">{(id) => <Input id={id} inputMode="numeric" disabled={f.ga_unknown} value={f.ga_weeks} onChange={(e) => set("ga_weeks", e.target.value)} />}</Field>
            <Field label="+ days">{(id) => <Input id={id} inputMode="numeric" disabled={f.ga_unknown} value={f.ga_days} onChange={(e) => set("ga_days", e.target.value)} />}</Field>
          </div>
          <Toggle checked={f.ga_unknown} onChange={(v) => set("ga_unknown", v)} label="I don't know the gestational age" />
          <Toggle checked={f.unable_to_breastfeed} onChange={(v) => set("unable_to_breastfeed", v)} label="My baby's care team said baby can't breastfeed right now" description="Only used to decide which clinical references could apply." />
        </Card>
        <Card className="flex flex-col gap-2">
          <h2 className="font-bold">Vaccination schedule</h2>
          <Segmented label="Schedule" value={f.schedule_id} onChange={(v) => set("schedule_id", v)} options={[{ value: "GOVERNMENT_OF_INDIA_UIP", label: "Government (UIP)" }, { value: "IAP_RECOMMENDED_SCHEDULE", label: "IAP" }]} />
          <p className="text-sm text-ink-2">You can change this later. Schedules are never mixed. Some schedules are pending clinical verification — you can still record doses.</p>
        </Card>
        {err && <Notice tone="allergy">{err}</Notice>}
        <Button type="submit" block busy={busy} disabled={!f.first_name || !f.birth_date}>Save baby</Button>
      </form>
    </>
  );
}
export default function AddBaby() { return <Suspense><AddBabyInner /></Suspense>; }
