"use client";
import { useState } from "react";

/** Bar chart with hatched "no data" bars (never zero-height) and a table alternative (spec §23, §33.1). */
export function DayBars({ days, label, unit = "ml" }: { days: { date: string; value: number | null; hasAnyData: boolean }[]; label: string; unit?: string }) {
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...days.map((d) => d.value ?? 0));
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <figcaption className="text-sm font-semibold">{label}</figcaption>
        <button className="min-h-10 rounded-full px-3 text-sm font-semibold text-sage" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button>
      </div>
      {table ? (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-2"><th className="py-1">Day</th><th>Value</th></tr></thead>
          <tbody>{days.map((d) => <tr key={d.date} className="border-t border-line"><td className="py-1">{d.date}</td><td className="num">{d.value != null ? `${d.value} ${unit}` : d.hasAnyData ? "Not measured" : "No data recorded"}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="flex h-40 items-end gap-1" role="img" aria-label={`${label}. ${days.filter((d) => d.value != null).length} days with measured values, ${days.filter((d) => !d.hasAnyData).length} days with no data recorded.`}>
          {days.map((d) => (
            <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex h-32 w-full items-end">
                {d.value != null ? <div className="w-full rounded-t-lg bg-sage" style={{ height: `${Math.max(4, (d.value / max) * 100)}%` }} title={`${d.value} ${unit}`} />
                  : <div className={`h-full w-full rounded-lg ${d.hasAnyData ? "bg-sunken" : "hatch"}`} title={d.hasAnyData ? "Feeds recorded, none measured" : "No data recorded"} />}
              </div>
              <span className="text-[10px] text-ink-2">{d.date.slice(8)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="text-xs text-ink-2"><span className="mr-1 inline-block h-3 w-3 rounded-sm align-middle hatch" /> No data recorded · <span className="mr-1 inline-block h-3 w-3 rounded-sm bg-sunken align-middle" /> Feeds without measured amounts</p>
    </figure>
  );
}

type Band = { x: number; p3: number; p15: number; p50: number; p85: number; p97: number };
type Pt = { x: number; value: number; percentile: number | null; z_score: number | null; local_date: string };
/** WHO growth chart: reference bands from imported LMS data + the baby's points. Labelled "Growth reference". */
export function GrowthChart({ bands, points, xLabel, yUnit, xIsDays }: { bands: Band[]; points: Pt[]; xLabel: string; yUnit: string; xIsDays: boolean }) {
  const [table, setTable] = useState(false);
  if (!bands.length) return null;
  const W = 340, H = 220, P = 32;
  const xs = bands.map((b) => b.x), ys = [...bands.flatMap((b) => [b.p3, b.p97]), ...points.map((p) => p.value)];
  const x0 = Math.min(...xs), x1 = Math.max(...xs, ...points.map((p) => p.x)), y0 = Math.min(...ys) * 0.95, y1 = Math.max(...ys) * 1.03;
  const sx = (x: number) => P + ((x - x0) / (x1 - x0 || 1)) * (W - P - 8), sy = (y: number) => H - P + 8 - ((y - y0) / (y1 - y0 || 1)) * (H - P - 8);
  const path = (k: keyof Band) => bands.map((b, i) => `${i ? "L" : "M"}${sx(b.x).toFixed(1)},${sy(b[k]).toFixed(1)}`).join("");
  const area = (lo: keyof Band, hi: keyof Band) => `${path(hi)}${[...bands].reverse().map((b) => `L${sx(b.x).toFixed(1)},${sy(b[lo]).toFixed(1)}`).join("")}Z`;
  const xTick = (x: number) => (xIsDays ? `${Math.round(x / 30.4375)}m` : `${x}`);
  return (
    <figure className="flex flex-col gap-2">
      <div className="flex justify-end"><button className="min-h-10 rounded-full px-3 text-sm font-semibold text-sage" onClick={() => setTable((t) => !t)}>{table ? "Show chart" : "Show table"}</button></div>
      {table ? (
        <table className="w-full text-sm">
          <thead><tr className="text-left text-ink-2"><th>Date</th><th>Value</th><th>Percentile</th><th>z</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.local_date + p.x} className="border-t border-line"><td className="py-1">{p.local_date}</td><td className="num">{p.value} {yUnit}</td><td className="num">{p.percentile ?? "—"}</td><td className="num">{p.z_score ?? "—"}</td></tr>)}</tbody>
        </table>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Growth reference chart with ${points.length} measurements. Use the table view for exact values.`}>
          <path d={area("p3", "p97")} fill="var(--sage-soft)" opacity="0.6" />
          <path d={area("p15", "p85")} fill="var(--sage-soft)" />
          {(["p3", "p15", "p50", "p85", "p97"] as const).map((k) => <path key={k} d={path(k)} fill="none" stroke="var(--sage)" strokeWidth={k === "p50" ? 1.6 : 0.7} strokeDasharray={k === "p50" ? undefined : "3 3"} />)}
          {(["p3", "p50", "p97"] as const).map((k) => <text key={k} x={W - 6} y={sy(bands[bands.length - 1][k]) - 3} fontSize="8" textAnchor="end" fill="var(--ink-2)">{k.slice(1)}th</text>)}
          <line x1={P} y1={H - P + 8} x2={W - 8} y2={H - P + 8} stroke="var(--line)" />
          {[0, 0.25, 0.5, 0.75, 1].map((t) => { const x = x0 + t * (x1 - x0); return <text key={t} x={sx(x)} y={H - 10} fontSize="9" textAnchor="middle" fill="var(--ink-2)">{xTick(Math.round(x * 10) / 10)}</text>; })}
          {[0, 0.5, 1].map((t) => { const y = y0 + t * (y1 - y0); return <text key={t} x={4} y={sy(y) + 3} fontSize="9" fill="var(--ink-2)">{y.toFixed(1)}</text>; })}
          {points.length > 1 && <path d={points.map((p, i) => `${i ? "L" : "M"}${sx(p.x)},${sy(p.value)}`).join("")} fill="none" stroke="var(--ink)" strokeWidth="1.4" />}
          {points.map((p) => <circle key={p.local_date + p.x} cx={sx(p.x)} cy={sy(p.value)} r="4" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />)}
          <text x={W / 2} y={H - 1} fontSize="9" textAnchor="middle" fill="var(--ink-2)">{xLabel}</text>
        </svg>
      )}
    </figure>
  );
}
