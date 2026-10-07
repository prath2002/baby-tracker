"use client";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtTime } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, LinkButton, Loading, PageHeader, Select, Sheet, useToast } from "@/components/ui";
import { BabyAvatar, BabyNav, displayName, useBaby, canLog } from "@/components/baby";
import { EXCRETION_ICON, EXCRETION_LABEL, excretionCountText, type ExcretionType } from "@/components/timeline-icons";

/** Excretion history: pee, poop, both, vomit — with the parent's notes. */
export default function ExcretionHistory({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [type, setType] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [all, setAll] = useState<any[] | null>(null);
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/excretions?limit=50${type ? `&type=${type}` : ""}${cursor ? `&cursor=${cursor}` : ""}`);
  const [menu, setMenu] = useState<any>(null);
  const [moveTo, setMoveTo] = useState(false);
  const { data: babies } = useApi<any>(moveTo ? "/babies" : null);
  const rows = cursor && all ? [...all, ...(data?.data ?? [])] : data?.data ?? [];
  if (!baby) return <Loading />;
  const groups = rows.reduce((m: Record<string, any[]>, x: any) => ((m[x.local_date] ??= []).push(x), m), {});
  const changed = () => { invalidate(`/babies/${babyId}`); invalidate("/home"); invalidate("/timeline"); reload(); };
  async function del(x: any) {
    try {
      await api("DELETE", `/babies/${babyId}/excretions/${x.id}`); setMenu(null); changed();
      toast({ text: "Entry deleted", action: { label: "Undo", run: () => api("POST", `/babies/${babyId}/excretions/${x.id}/restore`).then(changed) } });
    } catch (e) { toast({ text: errorText(e), tone: "error" }); }
  }
  async function move(x: any, target: any) {
    if (!confirm(`Move this entry from ${baby!.first_name} to ${displayName(target)}?`)) return;
    try { await api("POST", `/babies/${babyId}/excretions/${x.id}/move`, { body: { target_baby_id: target.id }, ifMatch: x.version }); setMenu(null); setMoveTo(false); invalidate("/"); reload(); toast({ text: `Moved to ${target.first_name}` }); }
    catch (e) { toast({ text: errorText(e), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title="Excretions" subtitle={displayName(baby)} action={canLog(baby.my_role) && <LinkButton href={`/babies/${babyId}/excretions/new`} className="min-h-10 px-4 text-sm">+ Add</LinkButton>} />
      <BabyNav babyId={babyId} active="excretions" />
      <div className="mb-3"><Select aria-label="Filter by type" value={type} onChange={(e) => { setType(e.target.value); setCursor(null); setAll(null); }}><option value="">All types</option>{Object.entries(EXCRETION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
      {loading && !rows.length && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {!loading && !rows.length && <EmptyState icon="💧" title="Nothing logged yet" body="Log pee, poop or vomit with a short note — colour, texture, what came up." action={canLog(baby.my_role) && <LinkButton href={`/babies/${babyId}/excretions/new`}>Add excretion</LinkButton>} />}
      {Object.entries(groups).map(([day, list]) => (
        <section key={day} className="mb-4">
          <h2 className="mb-1 flex items-baseline justify-between text-sm font-bold text-ink-2"><span>{fmtDate(day)}</span>{!type && <span className="num font-semibold">{excretionCountText((list as any[]).map((x) => x.excretion_type))}</span>}</h2>
          <ul className="card divide-y divide-line p-1">
            {(list as any[]).map((x) => (
              <li key={x.id}>
                <button onClick={() => setMenu(x)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left" aria-label={`${EXCRETION_LABEL[x.excretion_type as ExcretionType]} at ${fmtTime(x.occurred_at, baby.household_timezone)}. Options`}>
                  <span className="num w-20 text-sm text-ink-2">{fmtTime(x.occurred_at, baby.household_timezone)}</span>
                  <span aria-hidden className="w-8 text-center">{EXCRETION_ICON[x.excretion_type as ExcretionType]}</span>
                  <span className="min-w-0 flex-1"><span className="block font-semibold">{EXCRETION_LABEL[x.excretion_type as ExcretionType]}</span>{x.notes && <span className="block text-sm text-ink-2">{x.notes}</span>}</span>
                  {x.moved_from_baby_id && <Badge>moved</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data?.next_cursor && <Button variant="secondary" block onClick={() => { setAll(rows); setCursor(data.next_cursor); }}>Load more</Button>}
      <Sheet open={!!menu && !moveTo} onClose={() => setMenu(null)} title="Entry options">
        {menu && <div className="flex flex-col gap-2">
          {canLog(baby.my_role) && <LinkButton variant="secondary" href={`/babies/${babyId}/excretions/new?edit=${menu.id}`}>Edit</LinkButton>}
          {canLog(baby.my_role) && <Button variant="secondary" onClick={() => setMoveTo(true)}>Move to another baby…</Button>}
          {canLog(baby.my_role) && <Button variant="danger" onClick={() => del(menu)}>Delete</Button>}
        </div>}
      </Sheet>
      <Sheet open={moveTo} onClose={() => { setMoveTo(false); setMenu(null); }} title="Move to which baby?">
        <ul className="flex flex-col gap-2">{babies?.data?.filter((b: any) => b.id !== babyId).map((b: any) => <li key={b.id}><button onClick={() => move(menu, b)} className="flex min-h-16 w-full items-center gap-3 rounded-2xl bg-sunken px-3"><BabyAvatar baby={b} /><span className="font-bold">{displayName(b)}</span></button></li>)}</ul>
      </Sheet>
    </>
  );
}
