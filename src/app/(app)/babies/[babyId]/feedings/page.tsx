"use client";
import Link from "next/link";
import { use, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate, fmtTime } from "@/lib/format";
import { Badge, Button, EmptyState, ErrorState, LinkButton, Loading, PageHeader, Select, Sheet, useToast } from "@/components/ui";
import { BabyAvatar, BabyNav, displayName, useBaby, canLog } from "@/components/baby";

const LABEL: Record<string, string> = { DIRECT_BREASTFEEDING: "Breastfeed", EXPRESSED_BREASTMILK: "Expressed milk", FORMULA: "Formula", OTHER: "Other" };

/** Feeding History (screen 11). */
export default function FeedingHistory({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const toast = useToast();
  const { data: baby } = useBaby(babyId);
  const [type, setType] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [all, setAll] = useState<any[] | null>(null);
  const { data, error, loading, reload } = useApi<any>(`/babies/${babyId}/feedings?limit=50${type ? `&type=${type}` : ""}${cursor ? `&cursor=${cursor}` : ""}`);
  const [menu, setMenu] = useState<any>(null);
  const [moveTo, setMoveTo] = useState(false);
  const { data: babies } = useApi<any>(moveTo ? "/babies" : null);
  const rows = cursor && all ? [...all, ...(data?.data ?? [])] : data?.data ?? [];
  if (!baby) return <Loading />;
  const groups = rows.reduce((m: Record<string, any[]>, f: any) => ((m[f.local_date] ??= []).push(f), m), {});
  async function del(f: any) {
    try {
      await api("DELETE", `/babies/${babyId}/feedings/${f.id}`); setMenu(null); invalidate(`/babies/${babyId}`); reload();
      toast({ text: "Feed deleted", action: { label: "Undo", run: () => api("POST", `/babies/${babyId}/feedings/${f.id}/restore`).then(() => { invalidate(`/babies/${babyId}`); reload(); }) } });
    } catch (e) { toast({ text: errorText(e), tone: "error" }); }
  }
  async function move(f: any, target: any) {
    if (!confirm(`Move this feed from ${baby!.first_name} to ${displayName(target)}?`)) return;
    try { await api("POST", `/babies/${babyId}/feedings/${f.id}/move`, { body: { target_baby_id: target.id }, ifMatch: f.version }); setMenu(null); setMoveTo(false); invalidate("/"); reload(); toast({ text: `Moved to ${target.first_name}` }); }
    catch (e) { toast({ text: errorText(e), tone: "error" }); }
  }
  return (
    <>
      <PageHeader title="Feeding history" back={`/babies/${babyId}/milk`} subtitle={displayName(baby)} action={canLog(baby.my_role) && <LinkButton href={`/babies/${babyId}/feedings/new`} className="min-h-10 px-4 text-sm">+ Feed</LinkButton>} />
      <BabyNav babyId={babyId} active="milk" />
      <div className="mb-3"><Select aria-label="Filter by type" value={type} onChange={(e) => { setType(e.target.value); setCursor(null); setAll(null); }}><option value="">All types</option>{Object.entries(LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></div>
      {loading && !rows.length && <Loading />}
      {error && <ErrorState message={error.message} onRetry={reload} />}
      {!loading && !rows.length && <EmptyState title="No feeds yet" body="Feeds you log appear here." action={canLog(baby.my_role) && <LinkButton href={`/babies/${babyId}/feedings/new`}>Add feeding</LinkButton>} />}
      {Object.entries(groups).map(([day, list]) => (
        <section key={day} className="mb-4">
          <h2 className="mb-1 text-sm font-bold text-ink-2">{fmtDate(day)}</h2>
          <ul className="card divide-y divide-line p-1">
            {(list as any[]).map((f) => (
              <li key={f.id}>
                <button onClick={() => setMenu(f)} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left" aria-label={`${LABEL[f.feeding_type]} at ${fmtTime(f.occurred_at, baby.household_timezone)}. Options`}>
                  <span className="num w-20 text-sm text-ink-2">{fmtTime(f.occurred_at, baby.household_timezone)}</span>
                  <span className="flex-1 font-semibold">{LABEL[f.feeding_type]}{f.feeding_type === "OTHER" && f.other_description ? ` · ${f.other_description}` : ""}</span>
                  <span className="num text-sm">{f.quantity_ml != null ? `${f.quantity_ml} ml` : f.feeding_type === "DIRECT_BREASTFEEDING" ? [f.breast_side?.toLowerCase(), f.duration_minutes && `${f.duration_minutes} min`].filter(Boolean).join(" · ") || "—" : "—"}</span>
                  {f.moved_from_baby_id && <Badge>moved</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data?.next_cursor && <Button variant="secondary" block onClick={() => { setAll(rows); setCursor(data.next_cursor); }}>Load more</Button>}
      <Sheet open={!!menu && !moveTo} onClose={() => setMenu(null)} title="Feed options">
        {menu && <div className="flex flex-col gap-2">
          <LinkButton variant="secondary" href={`/babies/${babyId}/feedings/new?edit=${menu.id}`}>Edit</LinkButton>
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
