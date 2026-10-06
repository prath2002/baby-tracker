"use client";
import { use, useEffect, useState } from "react";
import { fmtDate, fmtMl } from "@/lib/format";
import { Card, ErrorState, Loading } from "@/components/ui";

/** Read-only, time-boxed shared summary for a doctor (spec §35 share links). */
export default function Shared({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { fetch(`/api/v1/share/${encodeURIComponent(token)}`).then(async (r) => (r.ok ? setD(await r.json()) : setErr("This link has expired or was revoked."))).catch(() => setErr("Couldn't load this summary.")); }, [token]);
  if (err) return <main className="mx-auto max-w-xl p-6"><ErrorState message={err} /></main>;
  if (!d) return <main className="mx-auto max-w-xl p-6"><Loading /></main>;
  const s = d.summary;
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 p-6">
      <header><p className="text-sm font-semibold text-ink-2">Shared summary · read-only</p><h1 className="text-3xl font-extrabold">{d.baby.first_name}</h1><p className="text-ink-2">DOB {fmtDate(d.baby.birth_date)} · {s.age.display} · {fmtDate(s.from)} – {fmtDate(s.to)}</p></header>
      <Card><h2 className="font-bold text-allergy">Allergies</h2><p>{s.allergies.length ? s.allergies.map((a: any) => `${a.substance} (${a.status === "CONFIRMED_BY_DOCTOR" ? "confirmed" : "suspected"})`).join(", ") : "None recorded"}</p></Card>
      <Card><h2 className="font-bold">Feeding (recorded)</h2>
        <p>Feeds: {s.feeding.totalFeeds} on {s.feeding.daysWithAnyData} of {s.feeding.days.length} days · Direct breastfeeding sessions: {s.feeding.directBreastfeedingSessions} (not converted to volume)</p>
        <p>Measured milk: {s.feeding.totalMeasuredMl != null ? `${fmtMl(s.feeding.totalMeasuredMl)} total, ${fmtMl(s.feeding.avgMeasuredMlPerDayWithData)}/day over ${s.feeding.daysWithMeasuredData} day(s) with measured feeds` : "not available"}</p></Card>
      <Card><h2 className="font-bold">Measurements</h2>{s.weights.length ? <ul>{s.weights.map((w: any) => <li key={w.id}>{fmtDate(w.local_date)}: {[w.weight_kg && `${w.weight_kg} kg`, w.length_cm && `${w.length_cm} cm`, w.head_circumference_cm && `HC ${w.head_circumference_cm} cm`].filter(Boolean).join(" · ")}</li>)}</ul> : <p>None in this period</p>}</Card>
      <Card><h2 className="font-bold">Vaccinations</h2>{s.vaccinations.length ? <ul>{s.vaccinations.map((v: any) => <li key={v.id}>{fmtDate(v.given_on)}: {v.vaccine_name_as_recorded} {v.dose_label}</li>)}</ul> : <p>None in this period</p>}</Card>
      <Card><h2 className="font-bold">Medicines</h2>{s.medicines.length ? <ul>{s.medicines.map((m: any) => <li key={m.id}>{m.medicine_name} · {m.status.toLowerCase()}</li>)}</ul> : <p>None recorded</p>}</Card>
      <p className="text-xs text-ink-2">{s.disclaimer}</p>
    </main>
  );
}
