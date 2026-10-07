"use client";
import { Suspense, use, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText, fieldErrors } from "@/lib/api";
import { invalidate } from "@/lib/useApi";
import { isoToLocalInput, localInputToIso, nowLocalInput } from "@/lib/format";
import { uuidv7 } from "@/lib/ids";
import { Button, Card, ErrorState, Field, Input, Loading, Notice, Segmented, Textarea, useToast } from "@/components/ui";
import { BabyIdentityBar, displayName, useBaby, canLog } from "@/components/baby";
import { EXCRETION_LABEL, type ExcretionType } from "@/components/timeline-icons";

const PLACEHOLDER: Record<ExcretionType, string> = {
  URINE: "e.g. pale yellow, strong smell",
  STOOL: "e.g. yellow, liquidy, seedy",
  URINE_AND_STOOL: "e.g. pale pee; poop mustard, soft",
  VOMIT: "What came up? e.g. curdled milk after feed",
};

/** Add / edit an excretion (pee, poop, both, vomit). Baby is fixed at form-open time (offline-safe). */
function AddExcretionInner({ babyId }: { babyId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const editId = params.get("edit");
  const toast = useToast();
  const { data: baby, error } = useBaby(babyId);
  const clientId = useRef(uuidv7());
  const [type, setType] = useState<ExcretionType>((params.get("type") as ExcretionType) in EXCRETION_LABEL ? (params.get("type") as ExcretionType) : "URINE");
  const [when, setWhen] = useState("");
  const [notes, setNotes] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState(false);

  useEffect(() => { if (baby && !when) setWhen(nowLocalInput(baby.household_timezone)); }, [baby, when]);
  useEffect(() => {
    if (!editId || !baby) return;
    api("GET", `/babies/${babyId}/excretions/${editId}`).then((x) => {
      setType(x.excretion_type); setWhen(isoToLocalInput(x.occurred_at, baby.household_timezone)); setNotes(x.notes ?? ""); setVersion(x.version);
    }).catch((e) => setErr(errorText(e)));
  }, [editId, baby, babyId]);

  if (error) return <ErrorState message={error.message} />;
  if (!baby) return <Loading />;
  if (!canLog(baby.my_role)) return <Notice>Your role can view this baby's records but not add entries.</Notice>;

  async function save(e?: React.FormEvent, force = false) {
    e?.preventDefault(); setBusy(true); setErr(null); setFe({});
    const body: Record<string, unknown> = { occurred_at: localInputToIso(when, baby!.household_timezone), occurred_tz: baby!.household_timezone, excretion_type: type, notes: notes.trim() || null };
    if (force) body.force = true;
    const done = () => { invalidate(`/babies/${babyId}`); invalidate("/home"); invalidate("/timeline"); };
    try {
      let saved: any;
      if (editId) saved = await api("PATCH", `/babies/${babyId}/excretions/${editId}`, { body, ifMatch: version! });
      else saved = await api("POST", `/babies/${babyId}/excretions`, { body: { ...body, client_id: clientId.current }, offline: true });
      done();
      toast({ text: `${EXCRETION_LABEL[type]} ${editId ? "updated" : "saved"} for ${baby!.first_name}`, action: editId ? undefined : { label: "Undo", run: () => api("DELETE", `/babies/${babyId}/excretions/${saved.id}`).then(done) } });
      router.push(`/babies/${babyId}/excretions`);
    } catch (x) {
      if (x instanceof ApiProblem && x.code === "QUEUED_OFFLINE") { toast({ text: `Saved offline for ${baby!.first_name} — will sync` }); router.push(`/babies/${babyId}/excretions`); return; }
      if (x instanceof ApiProblem && x.code === "DUPLICATE_SUSPECTED") setDuplicate(true);
      setErr(errorText(x)); setFe(fieldErrors(x));
    } finally { setBusy(false); }
  }

  return (
    <>
      <BabyIdentityBar baby={baby} changeHref={editId ? undefined : "/home"} />
      <h1 className="mb-4 text-2xl font-extrabold">{editId ? "Edit entry" : "Add excretion"}</h1>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Segmented<ExcretionType> label="Type" value={type} onChange={(v) => { setType(v); setDuplicate(false); }} options={[
          { value: "URINE", label: "Pee", icon: <span aria-hidden>💧</span> }, { value: "STOOL", label: "Poop", icon: <span aria-hidden>💩</span> },
          { value: "URINE_AND_STOOL", label: "Both", icon: <span aria-hidden>💧💩</span> }, { value: "VOMIT", label: "Vomit", icon: <span aria-hidden>🤮</span> }]} />
        <Card className="flex flex-col gap-4">
          <Field label="When" error={fe.occurred_at}>{(id, d) => <Input id={id} aria-describedby={d} type="datetime-local" required value={when} max={nowLocalInput(baby.household_timezone)} onChange={(e) => setWhen(e.target.value)} />}</Field>
          <Field label={type === "VOMIT" ? "What was it like? (optional)" : "Colour, texture, anything notable (optional)"} error={fe.notes}>
            {(id, d) => <Textarea id={id} aria-describedby={d} value={notes} placeholder={PLACEHOLDER[type]} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
          </Field>
        </Card>
        {err && <Notice tone={duplicate ? "caution" : "allergy"}>{err}</Notice>}
        {duplicate ? <Button type="button" busy={busy} onClick={() => save(undefined, true)}>Save anyway for {baby.first_name}</Button>
          : <Button type="submit" busy={busy} block disabled={!when}>{`Save for ${displayName(baby)}`}</Button>}
      </form>
    </>
  );
}
export default function AddExcretion({ params }: { params: Promise<{ babyId: string }> }) { const { babyId } = use(params); return <Suspense><AddExcretionInner babyId={babyId} /></Suspense>; }
