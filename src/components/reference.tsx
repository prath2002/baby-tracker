"use client";
import { useState } from "react";
import { Badge, Notice, Sheet } from "./ui";

type Prov = Record<string, string>;
export type ReferenceResult = {
  reference_status: string; display_mode: string; messages: string[]; preview_mode: boolean; pending_review: string[];
  guidance: { id: string; text: string; provenance: Prov; preview: boolean }[];
  rules: { rule_id: string; label: string; population: string; clinical_context: string; value_min: number | null; value_max: number | null; value_target: number | null; unit: string | null; frequency: string | null; warnings: string[]; provenance: Prov; preview: boolean }[];
  plan: { clinician_name: string; instructed_on: string; plan_text: string; volume_ml_per_feed: string | null; feeds_per_day: number | null; entered_from: string } | null;
};

export function SourceChip({ provenance }: { provenance: Prov }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className="inline-flex min-h-8 items-center gap-1 rounded-full bg-info-bg px-2.5 text-xs font-semibold text-info underline-offset-2 hover:underline">
        ⓘ Source: {provenance.organization?.split(/[,/]/)[0] ?? "—"}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Information based on…">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          {[["Organization", "organization"], ["Document", "document_title"], ["Type", "document_type"], ["Country", "country"], ["Population", "population"], ["Context", "clinical_context"],
            ["Published", "publication_date"], ["Version", "version"], ["Page / section", "page_or_section"], ["Evidence", "evidence_level"], ["Retrieved", "retrieved_at"], ["Verified", "verified_at"], ["Status", "verification_status"]]
            .map(([l, k]) => provenance[k] ? (<div key={k} className="contents"><dt className="font-semibold text-ink-2">{l}</dt><dd className="break-words">{provenance[k]}</dd></div>) : null)}
        </dl>
        {provenance.source_url && <p className="mt-3 text-sm"><a className="break-all text-info underline" href={provenance.source_url} target="_blank" rel="noopener noreferrer">{provenance.source_url}</a></p>}
        {provenance.notes && <p className="mt-3 text-sm text-ink-2">{provenance.notes}</p>}
      </Sheet>
    </>
  );
}

const fmtVal = (r: ReferenceResult["rules"][number]) => {
  const v = r.value_target ?? (r.value_min != null && r.value_max != null ? `${r.value_min}–${r.value_max}` : r.value_max != null ? `up to ${r.value_max}` : r.value_min);
  return `${v} ${r.unit ?? ""}`.trim();
};

/** Reference card modes: RESPONSIVE_GUIDANCE, CLINICAL_REFERENCE, CARE_TEAM_PLAN, NOT_ESTABLISHED, CONFLICT (spec §33.2). */
export function ReferenceCard({ r }: { r: ReferenceResult | undefined }) {
  if (!r) return null;
  return (
    <section aria-labelledby="ref-h" className="card flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="ref-h" className="text-lg font-bold">Reference guidance</h2>
        {r.preview_mode && <Badge tone="caution">PREVIEW · unverified</Badge>}
      </div>
      {r.plan && (
        <div className="rounded-2xl bg-sage-soft p-3">
          <p className="text-xs font-bold uppercase tracking-wide text-sage-strong">Care-team plan</p>
          <p className="font-semibold">{r.plan.plan_text}</p>
          <p className="text-sm text-ink-2">As recorded from {r.plan.clinician_name} on {r.plan.instructed_on} ({r.plan.entered_from.toLowerCase().replace(/_/g, " ")})</p>
        </div>
      )}
      {r.reference_status === "NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND" && (
        <div className="flex flex-col gap-1">
          <Badge tone="info">No universal milk amount applies</Badge>
          {r.messages.map((m) => <p key={m} className="text-sm">{m}</p>)}
        </div>
      )}
      {r.reference_status === "NOT_ESTABLISHED" && r.messages.map((m) => <p key={m} className="text-sm">{m}</p>)}
      {r.rules.length > 0 && (
        <div className="flex flex-col gap-2">
          {r.reference_status === "CONFLICT_REQUIRES_REVIEW" && <Notice tone="caution" title="Sources differ">These references come from different sources and are shown side by side. Follow your care team.</Notice>}
          {r.rules.map((x) => (
            <div key={x.rule_id} className="rounded-2xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2"><Badge tone="info">Clinical reference</Badge>{x.preview && <Badge tone="caution">unverified</Badge>}</div>
              <p className="num mt-1 font-display text-xl font-extrabold">{fmtVal(x)}</p>
              <p className="text-sm text-ink-2">Population: {x.population.toLowerCase().replace(/_/g, " ")} · {x.clinical_context.toLowerCase().replace(/_/g, " ")}{x.frequency && x.frequency !== "NOT_AVAILABLE" ? ` · ${x.frequency}` : ""}</p>
              <ul className="mt-1 list-disc pl-5 text-sm">{x.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              <div className="mt-2"><SourceChip provenance={x.provenance} /></div>
            </div>
          ))}
        </div>
      )}
      {r.guidance.map((g) => (
        <div key={g.id} className="rounded-2xl bg-sunken p-3 text-sm">
          <p>{g.text}</p>
          <div className="mt-2 flex items-center gap-2"><SourceChip provenance={g.provenance} />{g.preview && <Badge tone="caution">unverified</Badge>}</div>
        </div>
      ))}
      {r.pending_review.length > 0 && !r.guidance.length && <p className="text-xs text-ink-2">Some reference guidance is pending review by our pediatric reviewers and isn't shown yet.</p>}
      <p className="text-xs text-ink-2">Reference information only — not a substitute for your pediatrician. If you are worried about your baby, contact your doctor or nearest health facility.</p>
    </section>
  );
}
