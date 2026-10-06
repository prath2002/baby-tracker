"use client";
import { useState } from "react";
import { DateTime } from "luxon";
import { api, ApiProblem, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button, Card, Field, Input, Loading, Notice, PageHeader, Segmented, Select, Toggle, useToast } from "@/components/ui";
import { StepUpSheet } from "@/components/stepup";

/** Data export (screen 35). */
export default function Export() {
  const toast = useToast();
  const { data: me } = useApi<any>("/me");
  const { data: babies } = useApi<any>("/babies");
  const [baby, setBaby] = useState("");
  const [format, setFormat] = useState("PDF_VISIT_SUMMARY");
  const [from, setFrom] = useState(DateTime.now().minus({ days: 29 }).toISODate()!);
  const [to, setTo] = useState(DateTime.now().toISODate()!);
  const [docs, setDocs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(false);
  if (!babies || !me) return <Loading />;
  async function go() {
    setBusy(true);
    try {
      const e = await api("POST", "/exports", { body: { baby_id: baby, format, from, to, include_documents: docs } });
      const d = await api("POST", `/exports/${e.id}/download-url`);
      window.location.href = d.url; toast({ text: "Export ready — downloading" });
    } catch (x) { if (x instanceof ApiProblem && x.code === "STEP_UP_REQUIRED") setStep(true); else toast({ text: errorText(x), tone: "error" }); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Export data" back="/settings" />
      <Card className="flex flex-col gap-3">
        <Field label="Baby">{(id) => <Select id={id} value={baby} onChange={(e) => setBaby(e.target.value)}><option value="">Choose…</option>{babies.data.map((b: any) => <option key={b.id} value={b.id}>{b.first_name}</option>)}</Select>}</Field>
        <Segmented label="Format" value={format} onChange={setFormat} options={[{ value: "PDF_VISIT_SUMMARY", label: "Doctor PDF" }, { value: "JSON", label: "JSON" }, { value: "CSV", label: "CSV" }]} />
        {format === "PDF_VISIT_SUMMARY" && <div className="grid grid-cols-2 gap-3"><Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field><Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field></div>}
        {format !== "PDF_VISIT_SUMMARY" && <Toggle checked={docs} onChange={setDocs} label="Include document files" />}
        <Notice>Download links work once and expire after 5 minutes. Full data exports ask you to confirm it's you.</Notice>
        <Button busy={busy} disabled={!baby} onClick={go}>Create export</Button>
      </Card>
      <StepUpSheet open={step} me={me} onClose={() => setStep(false)} onDone={() => { setStep(false); go(); }} />
    </>
  );
}
