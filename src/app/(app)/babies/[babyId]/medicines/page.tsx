"use client";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtTime, todayIn } from "@/lib/format";
import { uuidv7 } from "@/lib/ids";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Notice, PageHeader, Segmented, Select, Sheet, Textarea, useToast } from "@/components/ui";
import { AllergyBanner, BabyNav, displayName, useBaby, canLog, canManage } from "@/components/baby";

/** Medicines (screen 25): user-defined schedules; doses marked given/skipped; never recommends or checks doses. */
export default function Medicines({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [tab, setTab] = useState<"ACTIVE" | "DONE">("ACTIVE");
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/medicines`);
  const { data: today, reload: reloadToday } = useApi<any>(`/babies/${babyId}/medicines-today`);
  const [add, setAdd] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!baby) return <Loading />;
  async function mark(slot: any, status: "GIVEN" | "SKIPPED") {
    try { await api("POST", `/babies/${babyId}/medicines/${slot.medicine_id}/doses`, { body: { status, scheduled_for: slot.scheduled_for, client_id: uuidv7() }, offline: true }); reloadToday(); toast({ text: `Dose marked ${status.toLowerCase()} for ${baby!.first_name}` }); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function markPrn(m: any) {
    try { await api("POST", `/babies/${babyId}/medicines/${m.id}/doses`, { body: { status: "GIVEN", client_id: uuidv7() }, offline: true }); toast({ text: `Dose recorded for ${baby!.first_name}` }); }
    catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function stop(m: any) {
    try { await api("PATCH", `/babies/${babyId}/medicines/${m.id}`, { body: { status: "STOPPED", end_date: todayIn(baby!.household_timezone) }, ifMatch: m.version }); reload(); reloadToday(); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const times = add.times.split(",").map((s: string) => s.trim()).filter(Boolean);
      await api("POST", `/babies/${babyId}/medicines`, { body: { medicine_name: add.name, dose_text_as_prescribed: add.dose || null, start_date: add.start, end_date: add.end || null, reason_as_given: add.reason || null, notes: add.notes || null,
        schedule: add.kind === "AS_NEEDED" ? { kind: "AS_NEEDED" } : add.kind === "EVERY_N_HOURS" ? { kind: "EVERY_N_HOURS", every_n_hours: Number(add.hours), anchor_time: times[0] || "08:00" } : { kind: "TIMES_OF_DAY", times_of_day: times } } });
      setAdd(null); invalidate(`/babies/${babyId}`); reload(); reloadToday(); toast({ text: "Medicine added" });
    } catch (x) { toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  const list = (data?.data ?? []).filter((m: any) => (tab === "ACTIVE" ? m.status === "ACTIVE" : m.status !== "ACTIVE"));
  return (
    <>
      <PageHeader title="Medicines" subtitle={displayName(baby)} action={canManage(baby.my_role) && <Button className="min-h-10 px-4 text-sm" onClick={() => setAdd({ name: "", dose: "", start: todayIn(baby.household_timezone), end: "", reason: "", notes: "", kind: "TIMES_OF_DAY", times: "", hours: "8" })}>+ Add</Button>} />
      <BabyNav babyId={babyId} active="medicines" />
      <div className="flex flex-col gap-4">
        <AllergyBanner baby={baby} />
        {today?.length > 0 && <Card>
          <h2 className="mb-2 text-lg font-bold">Today's doses</h2>
          <ul className="flex flex-col gap-2">{today.map((s: any) => (
            <li key={s.medicine_id + s.scheduled_for} className="flex items-center gap-2 rounded-2xl bg-sunken p-2">
              <span className="num w-20 text-sm">{fmtTime(s.scheduled_for, baby.household_timezone)}</span>
              <span className="flex-1 text-sm font-semibold">{s.medicine_name}<span className="block font-normal text-ink-2">{s.dose}</span></span>
              {s.status ? <Badge tone={s.status === "GIVEN" ? "success" : "neutral"}>{s.status.toLowerCase()}</Badge> : canLog(baby.my_role) && <>
                <Button className="min-h-11 px-3 text-sm" onClick={() => mark(s, "GIVEN")} aria-label={`Mark ${s.medicine_name} at ${fmtTime(s.scheduled_for, baby.household_timezone)} given`}>Given</Button>
                <Button variant="ghost" className="min-h-11 px-3 text-sm" onClick={() => mark(s, "SKIPPED")}>Skip</Button></>}
            </li>))}</ul>
        </Card>}
        <Segmented label="Show" value={tab} onChange={setTab} options={[{ value: "ACTIVE", label: "Active" }, { value: "DONE", label: "Completed / stopped" }]} />
        {loading && <Loading />}
        {error && <ErrorState message={error.message} onRetry={reload} />}
        {data && !list.length && <EmptyState icon="💊" title={tab === "ACTIVE" ? "No active medicines" : "Nothing here"} />}
        {list.map((m: any) => (
          <Card key={m.id}>
            <div className="flex items-start justify-between gap-2"><div><h3 className="font-bold">{m.medicine_name}</h3><p className="text-sm text-ink-2">{m.dose_text_as_prescribed ?? (m.dose_amount ? `${m.dose_amount} ${String(m.dose_unit ?? "").toLowerCase()}` : "Dose as prescribed")}</p></div><Badge>{m.status.toLowerCase()}</Badge></div>
            <p className="mt-1 text-sm">From {fmtDate(m.start_date)}{m.end_date ? ` to ${fmtDate(m.end_date)}` : ""} · {m.schedule ? (m.schedule.kind === "AS_NEEDED" ? "as needed" : m.schedule.kind === "EVERY_N_HOURS" ? `every ${m.schedule.every_n_hours} h` : `at ${m.schedule.times_of_day.join(", ")}`) : "no schedule"}</p>
            {m.reason_as_given && <p className="text-sm text-ink-2">Reason: {m.reason_as_given}</p>}
            <div className="mt-2 flex gap-2">
              {m.status === "ACTIVE" && m.schedule?.kind === "AS_NEEDED" && canLog(baby.my_role) && <Button variant="secondary" className="min-h-10 text-sm" onClick={() => markPrn(m)}>Record dose given now</Button>}
              {m.status === "ACTIVE" && canManage(baby.my_role) && <Button variant="ghost" className="min-h-10 text-sm" onClick={() => stop(m)}>Stop</Button>}
            </div>
          </Card>
        ))}
        <p className="text-xs text-ink-2">Follow your doctor's instructions. This app does not recommend medicines or check doses.</p>
      </div>
      <Sheet open={!!add} onClose={() => setAdd(null)} title="Add medicine">
        {add && <form onSubmit={save} className="flex flex-col gap-3">
          <AllergyBanner baby={baby} />
          <Field label="Medicine" required>{(id) => <Input id={id} required value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />}</Field>
          <Field label="Dose as prescribed">{(id) => <Input id={id} value={add.dose} onChange={(e) => setAdd({ ...add, dose: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-3"><Field label="Start">{(id) => <Input id={id} type="date" value={add.start} onChange={(e) => setAdd({ ...add, start: e.target.value })} />}</Field><Field label="End">{(id) => <Input id={id} type="date" value={add.end} onChange={(e) => setAdd({ ...add, end: e.target.value })} />}</Field></div>
          <Field label="Schedule">{(id) => <Select id={id} value={add.kind} onChange={(e) => setAdd({ ...add, kind: e.target.value })}><option value="TIMES_OF_DAY">At set times</option><option value="EVERY_N_HOURS">Every N hours</option><option value="AS_NEEDED">As needed</option></Select>}</Field>
          {add.kind !== "AS_NEEDED" && <Field label={add.kind === "TIMES_OF_DAY" ? "Times (HH:MM, comma separated)" : "First dose (HH:MM)"}>{(id) => <Input id={id} placeholder="08:00, 20:00" value={add.times} onChange={(e) => setAdd({ ...add, times: e.target.value })} />}</Field>}
          {add.kind === "EVERY_N_HOURS" && <Field label="Every how many hours">{(id) => <Input id={id} inputMode="numeric" value={add.hours} onChange={(e) => setAdd({ ...add, hours: e.target.value })} />}</Field>}
          <Field label="Reason as given by doctor">{(id) => <Input id={id} value={add.reason} onChange={(e) => setAdd({ ...add, reason: e.target.value })} />}</Field>
          <Field label="Notes">{(id) => <Textarea id={id} value={add.notes} onChange={(e) => setAdd({ ...add, notes: e.target.value })} />}</Field>
          <Notice>Nothing here is calculated. Enter what the doctor prescribed.</Notice>
          <Button type="submit" busy={busy} disabled={!add.name}>Save</Button>
        </form>}
      </Sheet>
    </>
  );
}
