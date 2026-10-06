"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiProblem, errorText } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, Field, Input, Loading, Notice, PageHeader, Select, Toggle, useToast } from "@/components/ui";
import { StepUpSheet } from "@/components/stepup";

/** Privacy & security (screen 34). Legal wording requires counsel review. */
function PrivacyInner() {
  const toast = useToast();
  const router = useRouter();
  const delBaby = useSearchParams().get("delete_baby");
  const { data: me } = useApi<any>("/me");
  const { data: consents, reload } = useApi<any[]>("/me/consents");
  const { data: babies } = useApi<any>("/babies");
  const [auditBaby, setAuditBaby] = useState<string>("");
  const { data: audit } = useApi<any>(auditBaby ? `/audit?baby_id=${auditBaby}` : null);
  const [step, setStep] = useState<null | (() => Promise<void>)>(null);
  const [confirmText, setConfirmText] = useState("");
  const [target, setTarget] = useState<string>(delBaby ?? "");
  if (!me) return <Loading />;
  const latest = (p: string) => consents?.find((c: any) => c.purpose === p)?.granted ?? false;
  async function setConsent(purpose: string, granted: boolean) {
    try { const r = await api("POST", "/me/consents", { body: { purpose, granted }, idempotent: false }); reload(); toast({ text: r.note ?? (granted ? "Consent given" : "Consent withdrawn") }); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  const withStepUp = (fn: () => Promise<void>) => async () => { try { await fn(); } catch (x) { if (x instanceof ApiProblem && x.code === "STEP_UP_REQUIRED") setStep(() => fn); else toast({ text: errorText(x), tone: "error" }); } };
  const deleteBaby = withStepUp(async () => { const r = await api("POST", "/me/deletion-requests", { body: { target_type: "BABY", target_id: target, confirmation_text: confirmText }, idempotent: false }); toast({ text: `Deletion scheduled — recoverable for ${r.purge_after_days} days` }); router.replace("/home"); });
  const deleteAccount = withStepUp(async () => { await api("POST", "/me/deletion-requests", { body: { target_type: "ACCOUNT", target_id: me.id, confirmation_text: confirmText }, idempotent: false }); router.replace("/welcome"); });
  const owned = (babies?.data ?? []).filter((b: any) => b.my_role === "OWNER");
  return (
    <>
      <PageHeader title="Privacy & security" back="/settings" />
      <div className="flex flex-col gap-4">
        <Notice tone="caution">Privacy terms are drafts pending legal/privacy counsel review.</Notice>
        <Card className="flex flex-col gap-1">
          <h2 className="font-bold">Your consents</h2>
          <Toggle checked={latest("CORE_PROCESSING")} onChange={(v) => setConsent("CORE_PROCESSING", v)} label="Core processing of my child's records" description="Required to use the app. Withdrawing stops new processing; export or delete your data below." />
          <Toggle checked={latest("ANALYTICS")} onChange={(v) => setConsent("ANALYTICS", v)} label="Anonymous usage analytics" />
          <Toggle checked={latest("SMS_REMINDERS")} onChange={(v) => setConsent("SMS_REMINDERS", v)} label="SMS / WhatsApp vaccine reminders" />
          <p className="text-xs text-ink-2">Notice version {me.privacy_notice_version} · <a className="underline" href="/privacy-notice">Read notice</a></p>
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Access log</h2>
          <Select aria-label="Baby" value={auditBaby} onChange={(e) => setAuditBaby(e.target.value)}><option value="">Choose a baby you own…</option>{owned.map((b: any) => <option key={b.id} value={b.id}>{b.first_name}</option>)}</Select>
          {audit && <><p className="mt-2 text-sm">{audit.chain_intact ? <Badge tone="success">Log integrity verified</Badge> : <Badge tone="allergy">Log integrity check failed</Badge>}</p>
            <ul className="mt-2 max-h-80 overflow-y-auto text-sm">{audit.data.map((a: any) => <li key={a.id} className="border-t border-line py-1"><span className="text-ink-2">{fmtDateTime(a.occurred_at)}</span> · {a.actor ?? "System"} · {a.action.toLowerCase().replace(/_/g, " ")}</li>)}</ul></>}
        </Card>
        <Card className="flex flex-col gap-3">
          <h2 className="font-bold">Delete data</h2>
          <p className="text-sm text-ink-2">Deletion is recoverable for 30 days, then permanent. Security logs are kept for at least a year.</p>
          {owned.length > 0 && <>
            <Select aria-label="Baby to delete" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose a baby…</option>{owned.map((b: any) => <option key={b.id} value={b.id}>{b.first_name}</option>)}</Select>
            {target && <Field label={`Type ${owned.find((b: any) => b.id === target)?.first_name} to confirm`}>{(id) => <Input id={id} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />}</Field>}
            <Button variant="danger" disabled={!target || !confirmText} onClick={deleteBaby}>Delete this baby's records</Button>
          </>}
          <Field label="Type DELETE MY ACCOUNT to delete your account">{(id) => <Input id={id} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />}</Field>
          <Button variant="danger" disabled={confirmText.trim().toUpperCase() !== "DELETE MY ACCOUNT"} onClick={deleteAccount}>Delete my account</Button>
        </Card>
        <Card><h2 className="font-bold">Grievance officer</h2><p className="text-sm">{me.grievance_contact}</p></Card>
      </div>
      <StepUpSheet open={!!step} me={me} onClose={() => setStep(null)} onDone={async () => { const f = step; setStep(null); await f?.(); }} />
    </>
  );
}
export default function Privacy() { return <Suspense><PrivacyInner /></Suspense>; }
