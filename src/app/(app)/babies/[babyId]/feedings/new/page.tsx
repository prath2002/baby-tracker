"use client";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText, fieldErrors } from "@/lib/api";
import { invalidate } from "@/lib/useApi";
import { isoToLocalInput, localInputToIso, nowLocalInput } from "@/lib/format";
import { uuidv7 } from "@/lib/ids";
import { Button, Card, ErrorState, Field, Input, Loading, Notice, Segmented, Select, Textarea, useToast } from "@/components/ui";
import { BabyIdentityBar, displayName, useBaby, canLog } from "@/components/baby";

type T = "DIRECT_BREASTFEEDING" | "EXPRESSED_BREASTMILK" | "FORMULA" | "OTHER";

/** Add / edit feeding (screen 10). Baby is fixed at form-open time (offline-safe). */
function AddFeedingInner({ babyId }: { babyId: string }) {
  const router = useRouter();
  const editId = useSearchParams().get("edit");
  const toast = useToast();
  const { data: baby, error } = useBaby(babyId);
  const clientId = useRef(uuidv7());
  const [type, setType] = useState<T>("DIRECT_BREASTFEEDING");
  const [when, setWhen] = useState("");
  const [side, setSide] = useState<string>("");
  const [duration, setDuration] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<"ML" | "OZ">("ML");
  const [method, setMethod] = useState("BOTTLE");
  const [other, setOther] = useState("");
  const [notes, setNotes] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<null | "QUANTITY" | "DUPLICATE">(null);
  const [timer, setTimer] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => { if (baby && !when) setWhen(nowLocalInput(baby.household_timezone)); }, [baby, when]);
  useEffect(() => {
    if (!editId || !baby) return;
    api(`GET`, `/babies/${babyId}/feedings/${editId}`).then((f) => {
      setType(f.feeding_type); setWhen(isoToLocalInput(f.occurred_at, baby.household_timezone)); setSide(f.breast_side ?? ""); setDuration(f.duration_minutes?.toString() ?? "");
      setQty(f.entered_unit === "OZ" ? String(f.quantity_oz ?? "") : String(f.quantity_ml ?? "")); setUnit(f.entered_unit ?? "ML"); setMethod(f.feeding_method ?? "BOTTLE"); setOther(f.other_description ?? ""); setNotes(f.notes ?? ""); setVersion(f.version);
    }).catch((e) => setErr(errorText(e)));
  }, [editId, baby, babyId]);
  useEffect(() => { if (timer === null) return; const t = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(t); }, [timer]);

  if (error) return <ErrorState message={error.message} />;
  if (!baby) return <Loading />;
  if (!canLog(baby.my_role)) return <Notice>Your role can view this baby's records but not add feeds.</Notice>;
  const measured = type === "EXPRESSED_BREASTMILK" || type === "FORMULA";
  const elapsed = timer !== null ? Math.floor((Date.now() - timer) / 1000) : 0;
  void tick;

  async function save(e?: React.FormEvent, force = false) {
    e?.preventDefault(); setBusy(true); setErr(null); setFe({});
    const body: Record<string, unknown> = {
      occurred_at: localInputToIso(when, baby!.household_timezone), occurred_tz: baby!.household_timezone, feeding_type: type, notes: notes || null,
      feeding_method: type === "DIRECT_BREASTFEEDING" ? "BREAST" : measured ? method : null,
      breast_side: type === "DIRECT_BREASTFEEDING" && side ? side : null, duration_minutes: type === "DIRECT_BREASTFEEDING" && duration ? Number(duration) : null,
      other_description: type === "OTHER" ? other || null : null,
    };
    if (measured) { if (unit === "ML") body.quantity_ml = Number(qty); else body.quantity_oz = Number(qty); }
    if (force || confirm === "QUANTITY") body.confirm_quantity = true;
    if (force) body.force = true;
    try {
      let saved: any;
      if (editId) saved = await api("PATCH", `/babies/${babyId}/feedings/${editId}`, { body, ifMatch: version! });
      else saved = await api("POST", `/babies/${babyId}/feedings`, { body: { ...body, client_id: clientId.current }, offline: true });
      invalidate(`/babies/${babyId}`); invalidate("/home");
      toast({ text: `Feed ${editId ? "updated" : "saved"} for ${baby!.first_name}`, action: editId ? undefined : { label: "Undo", run: () => api("DELETE", `/babies/${babyId}/feedings/${saved.id}`).then(() => { invalidate(`/babies/${babyId}`); invalidate("/home"); }) } });
      router.push(`/babies/${babyId}/milk`);
    } catch (x) {
      if (x instanceof ApiProblem && x.code === "QUEUED_OFFLINE") { toast({ text: `Saved offline for ${baby!.first_name} — will sync` }); router.push(`/babies/${babyId}/milk`); return; }
      if (x instanceof ApiProblem && x.code === "CONFIRMATION_REQUIRED") setConfirm("QUANTITY");
      if (x instanceof ApiProblem && x.code === "DUPLICATE_SUSPECTED") setConfirm("DUPLICATE");
      setErr(errorText(x)); setFe(fieldErrors(x));
    } finally { setBusy(false); }
  }

  return (
    <>
      <BabyIdentityBar baby={baby} changeHref={editId ? undefined : "/home"} />
      <h1 className="mb-4 text-2xl font-extrabold">{editId ? "Edit feed" : "Add feeding"}</h1>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Segmented<T> label="Feeding type" value={type} onChange={(v) => { setType(v); setConfirm(null); }} options={[
          { value: "DIRECT_BREASTFEEDING", label: "Breastfeed", icon: <span aria-hidden>🤱</span> }, { value: "EXPRESSED_BREASTMILK", label: "Expressed", icon: <span aria-hidden>🍼</span> },
          { value: "FORMULA", label: "Formula", icon: <span aria-hidden>🥛</span> }, { value: "OTHER", label: "Other", icon: <span aria-hidden>🥄</span> }]} />
        <Card className="flex flex-col gap-4">
          <Field label="Started at" error={fe.occurred_at}>{(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" required value={when} max={nowLocalInput(baby.household_timezone)} onChange={(e) => setWhen(e.target.value)} />}</Field>
          {type === "DIRECT_BREASTFEEDING" && (<>
            <div><p className="mb-1.5 text-sm font-semibold">Side</p><Segmented label="Breast side" value={side} onChange={setSide} options={[{ value: "LEFT", label: "Left" }, { value: "RIGHT", label: "Right" }, { value: "BOTH", label: "Both" }]} /></div>
            <Field label="Duration (minutes, optional)" hint="Duration is not converted to volume — breastfeeding amount can't be reliably measured this way.">
              {(id, d) => <div className="flex gap-2"><Input id={id} aria-describedby={d} inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, "").slice(0, 3))} />
                <Button type="button" variant="secondary" onClick={() => { if (timer === null) setTimer(Date.now()); else { setDuration(String(Math.max(1, Math.round(elapsed / 60)))); setTimer(null); } }}>{timer === null ? "Start timer" : `Stop ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`}</Button></div>}
            </Field>
          </>)}
          {measured && (<>
            <div className="grid grid-cols-[1fr_auto] items-end gap-3">
              <Field label="Amount" required error={fe.quantity_ml ?? fe.quantity_oz}>{(id, d) => <Input id={id} aria-describedby={d} inputMode="decimal" required value={qty} onChange={(e) => { setQty(e.target.value.replace(/[^\d.]/g, "")); setConfirm(null); }} className="num text-2xl" />}</Field>
              <Segmented label="Unit" value={unit} onChange={setUnit} options={[{ value: "ML", label: "ml" }, { value: "OZ", label: "oz" }]} />
            </div>
            <div className="flex gap-2">{[30, 60, 90, 120].map((n) => <button type="button" key={n} onClick={() => { setUnit("ML"); setQty(String(n)); }} className="min-h-10 flex-1 rounded-full border border-line text-sm font-semibold">{n} ml</button>)}</div>
            <Field label="Given by">{(id) => <Select id={id} value={method} onChange={(e) => setMethod(e.target.value)}>{["BOTTLE", "CUP", "PALADAI", "SPOON", "TUBE", "OTHER"].map((m) => <option key={m} value={m}>{m.charAt(0) + m.slice(1).toLowerCase()}</option>)}</Select>}</Field>
          </>)}
          {type === "OTHER" && <Field label="What was given?" hint="Shown separately; not counted as milk.">{(id, d) => <Input id={id} aria-describedby={d} value={other} onChange={(e) => setOther(e.target.value)} maxLength={200} />}</Field>}
          <Field label="Notes (optional)">{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}</Field>
        </Card>
        {err && <Notice tone={confirm ? "caution" : "allergy"}>{err}</Notice>}
        {confirm === "DUPLICATE" ? <Button type="button" busy={busy} onClick={() => save(undefined, true)}>Save anyway for {baby.first_name}</Button>
          : <Button type="submit" busy={busy} block disabled={!when || (measured && !qty)}>{confirm === "QUANTITY" ? "Confirm and save" : `Save feed for ${displayName(baby)}`}</Button>}
      </form>
    </>
  );
}
export default function AddFeeding({ params }: { params: Promise<{ babyId: string }> }) { const { babyId } = use(params); return <Suspense><AddFeedingInner babyId={babyId} /></Suspense>; }
