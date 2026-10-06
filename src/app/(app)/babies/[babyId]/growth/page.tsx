"use client";
import { use, useState } from "react";
import { useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { Badge, Card, ErrorState, Loading, Notice, PageHeader } from "@/components/ui";
import { BabyNav, displayName, useBaby } from "@/components/baby";
import { GrowthChart } from "@/components/charts";
import { SourceChip } from "@/components/reference";

const IND: [string, string, string, string][] = [
  ["WEIGHT_FOR_AGE", "Weight-for-age", "Age (months)", "kg"], ["LENGTH_HEIGHT_FOR_AGE", "Length-for-age", "Age (months)", "cm"], ["HEAD_CIRCUMFERENCE_FOR_AGE", "Head-for-age", "Age (months)", "cm"],
  ["WEIGHT_FOR_LENGTH", "Weight-for-length", "Length (cm)", "kg"], ["BMI_FOR_AGE", "BMI-for-age", "Age (months)", "kg/m²"], ["WEIGHT_VELOCITY", "Velocity", "", ""],
];

/** Growth chart (screen 16): WHO Child Growth Standards from imported official data; "Growth reference" wording only. */
export default function Growth({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const { data: baby } = useBaby(babyId);
  const [ind, setInd] = useState("WEIGHT_FOR_AGE");
  const { data: g, error, loading, reload } = useApi<any>(`/babies/${babyId}/growth?indicator=${ind}`);
  if (!baby) return <Loading />;
  const meta = IND.find((x) => x[0] === ind)!;
  const last = g?.points?.filter((p: any) => p.percentile != null).slice(-1)[0];
  return (
    <>
      <PageHeader title="Growth reference" subtitle={displayName(baby)} />
      <BabyNav babyId={babyId} active="growth" />
      <div role="tablist" aria-label="Indicator" className="-mx-4 mb-3 flex gap-2 overflow-x-auto px-4">
        {IND.map(([k, l]) => <button key={k} role="tab" aria-selected={ind === k} onClick={() => setInd(k)} className={`min-h-10 whitespace-nowrap rounded-full px-3 text-sm font-semibold ${ind === k ? "bg-ink text-canvas" : "border border-line bg-surface"}`}>{l}</button>)}
      </div>
      {loading && <Loading />}
      {error && (error.code === "GROWTH_REFERENCE_UNAVAILABLE" ? <Notice tone="caution">{error.problem.detail}</Notice> : <ErrorState message={error.message} onRetry={reload} />)}
      {g && (
        <div className="flex flex-col gap-3">
          {g.caveats?.map((c: string) => <Notice key={c} tone="caution">{c}</Notice>)}
          {g.status === "OK" && (
            <Card>
              <div className="mb-2 flex flex-wrap items-center gap-2"><h2 className="text-lg font-bold">{meta[1]}</h2>{g.preview && <Badge tone="caution">PREVIEW · unverified</Badge>}</div>
              {last && <p className="mb-2">Latest ({fmtDate(last.local_date)}): <b>{last.value} {meta[3]}</b> — growth reference: <b>{last.percentile}th percentile</b> (z {last.z_score})</p>}
              <GrowthChart bands={g.bands} points={g.points.filter((p: any) => p.value != null)} xLabel={meta[2]} yUnit={meta[3]} xIsDays={g.x_axis === "AGE_DAYS"} />
              <p className="mt-2 text-xs text-ink-2">Lines show the 3rd, 15th, 50th, 85th and 97th percentiles of the WHO Child Growth Standards. A percentile is a reference, not a verdict — discuss growth with your pediatrician.</p>
              <div className="mt-2"><SourceChip provenance={{ organization: "World Health Organization", document_title: "WHO Child Growth Standards", publication_date: "2006", source_url: g.provenance.source_url, version: `file sha256 ${g.provenance.file_sha256.slice(0, 12)}…` }} /></div>
            </Card>
          )}
          {g.status !== "OK" && g.status !== undefined && <Card><p className="text-ink-2">Growth reference unavailable for now.</p></Card>}
        </div>
      )}
    </>
  );
}
