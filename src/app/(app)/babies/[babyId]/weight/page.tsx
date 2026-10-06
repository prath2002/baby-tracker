"use client";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtKg, localInputToIso, nowLocalInput } from "@/lib/format";
import { uuidv7 } from "@/lib/ids";
import { Badge, Button, EmptyState, ErrorState, Field, Input, LinkButton, Loading, Notice, PageHeader, Segmented, Select, Sheet, useToast } from "@/components/ui";
import { BabyIdentityBar, BabyNav, displayName, useBaby, canLog } from "@/components/baby";

/** Weight tracker (screen 15). */
function WeightInner({ babyId }: { babyId: string }) {
  const toast = useToast();
  const add = useSearchParams().get("add") === "1";
  const { data: baby } = useBaby(babyId);
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/measurements?limit=100`);
  const [open, setOpen] = useState(add);
  const [f, setF] = useState({ when: "", weight: "", wunit: "kg", length: "", position: "RECUMBENT", hc: "", source: "HOME_SCALE", notes: "" });
  const [confirm, setConfirm] = useState<null | string>(null);
  const [busy, setBusy] = useState(false);
  const clientId = useRef(uuidv7());
  useEffect(() => { if (baby && !f.when) setF((x) => ({ ...x, when: nowLocalInput(baby.household_timezone) })); }, [baby, f.when]);
  if (!baby) return <Loading />;
  async function save(e?: React.FormEvent) {
    e?.preventDefault(); setBusy(true);
    const kg = f.weight ? Number(f.weight) / (f.wunit === "g" ? 1000 : 1) : null;
    try {
      await api("POST", `/babies/${babyId}/measurements`, { offline: true, body: { measured_at: localInputToIso(f.when, baby!.household_timezone), measured_tz: baby!.household_timezone, weight_kg: kg,
        length_cm: f.length ? Number(f.length) : null, length_position: f.length ? f.position : null, head_circumference_cm: f.hc ? Number(f.hc) : null, measurement_source: f.source, notes: f.notes || null,
        client_id: clientId.current, confirm: !!confirm, force: confirm === "DUPLICATE_SUSPECTED" } });
      setOpen(false); setConfirm(null); clientId.current = uuidv7(); invalidate(`/babies/${babyId}`); invalidate("/home"); reload();
      toast({ text: `Measurement saved for ${baby!.first_name}` });
    } catch (x) {
      if (x instanceof ApiProblem && x.code === "QUEUED_OFFLINE") { setOpen(false); toast({ text: "Saved offline — will sync" }); }
      else if (x instanceof ApiProblem && (x.code === "CONFIRMATION_REQUIRED" || x.code === "DUPLICATE_SUSPECTED")) setConfirm(x.code === "DUPLICATE_SUSPECTED" ? "DUPLICATE_SUSPECTED" : x.problem.detail ?? "Please confirm");
      else toast({ text: errorText(x), tone: "error" });
    } finally { setBusy(false); }
  }
  async function del(id: string) {
    try { await api("DELETE", `/babies/${babyId}/measurements/${id}`); reload(); invalidate("/home"); toast({ text: "Measurement deleted" }); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title="Weight & measurements" subtitle={displayName(baby)} action={canLog(baby.my_role) && <Button className="min-h-10 px-4 text-sm" onClick={() => setOpen(true)}>+ Add</Button>} />
      <BabyNav babyId={babyId} active="weight" />
      {loading && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {data && !data.data.length && <EmptyState title="No measurements yet" body="Add weight, length or head circumference." action={canLog(baby.my_role) && <Button onClick={() => setOpen(true)}>Add measurement</Button>} />}
      <ul className="flex flex-col gap-2">
        {data?.data.map((m: any) => (
          <li key={m.id} className="card flex items-center gap-3 p-3">
            <div className="flex-1">
              <p className="font-semibold">{[m.weight_kg != null && fmtKg(m.weight_kg), m.length_cm != null && `${m.length_cm} cm`, m.head_circumference_cm != null && `HC ${m.head_circumference_cm} cm`].filter(Boolean).join(" · ")}</p>
              <p className="text-sm text-ink-2">{fmtDate(m.local_date)} {m.measurement_source === "HOME_SCALE" && <Badge>home scale</Badge>}</p>
              {m.change_since_previous_g != null && <p className="text-sm">Change: {m.change_since_previous_g > 0 ? "+" : ""}{m.change_since_previous_g} g over {m.days_since_previous} day(s){m.g_per_day != null ? ` · ${m.g_per_day} g/day` : ""}</p>}
            </div>
            {canLog(baby.my_role) && <button onClick={() => del(m.id)} className="min-h-12 min-w-12 rounded-full text-ink-2" aria-label="Delete measurement">🗑</button>}
          </li>
        ))}
      </ul>
      <LinkButton href={`/babies/${babyId}/growth`} variant="secondary" block className="mt-4">View growth reference</LinkButton>
      <Sheet open={open} onClose={() => setOpen(false)} title="Add measurement">
        <BabyIdentityBar baby={baby} />
        <form onSubmit={save} className="flex flex-col gap-3">
          <Field label="When">{(id) => <Input id={id} type="datetime-local" value={f.when} max={nowLocalInput(baby.household_timezone)} onChange={(e) => setF({ ...f, when: e.target.value })} />}</Field>
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <Field label="Weight">{(id) => <Input id={id} inputMode="decimal" className="num text-xl" value={f.weight} onChange={(e) => setF({ ...f, weight: e.target.value.replace(/[^\d.]/g, "") })} />}</Field>
            <Segmented label="Weight unit" value={f.wunit} onChange={(v) => setF({ ...f, wunit: v })} options={[{ value: "kg", label: "kg" }, { value: "g", label: "g" }]} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Length (cm)">{(id) => <Input id={id} inputMode="decimal" value={f.length} onChange={(e) => setF({ ...f, length: e.target.value.replace(/[^\d.]/g, "") })} />}</Field>
            <Field label="Head circumference (cm)">{(id) => <Input id={id} inputMode="decimal" value={f.hc} onChange={(e) => setF({ ...f, hc: e.target.value.replace(/[^\d.]/g, "") })} />}</Field>
          </div>
          {f.length && <Segmented label="Length measured" value={f.position} onChange={(v) => setF({ ...f, position: v })} options={[{ value: "RECUMBENT", label: "Lying down" }, { value: "STANDING", label: "Standing" }]} />}
          <Field label="Measured at">{(id) => <Select id={id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="HOME_SCALE">Home scale</option><option value="CLINIC">Clinic</option><option value="HOSPITAL">Hospital</option><option value="ANGANWADI">Anganwadi</option><option value="OTHER">Other</option></Select>}</Field>
          {confirm && <Notice tone="caution">{confirm === "DUPLICATE_SUSPECTED" ? "A measurement already exists for this day. Save another anyway?" : confirm}</Notice>}
          <Button type="submit" busy={busy} disabled={!f.weight && !f.length && !f.hc}>{confirm ? "Confirm and save" : `Save for ${baby.first_name}`}</Button>
        </form>
      </Sheet>
    </>
  );
}
export default function Weight({ params }: { params: Promise<{ babyId: string }> }) { const { babyId } = use(params); return <Suspense><WeightInner babyId={babyId} /></Suspense>; }
