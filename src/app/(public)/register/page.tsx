"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText, fieldErrors } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Button, Card, Field, Input, Loading, Notice, Toggle } from "@/components/ui";

/** Registration (screen 4): guardian + adult attestation, granular consent (DPDP — requires counsel review). */
export default function Register() {
  const router = useRouter();
  const { data: me, loading } = useApi<any>("/me");
  const [name, setName] = useState("");
  const [guardian, setGuardian] = useState(false);
  const [adult, setAdult] = useState(false);
  const [read, setRead] = useState(false);
  const [core, setCore] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [sms, setSms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  if (loading || !me) return <main className="mx-auto max-w-md p-6"><Loading /></main>;
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api("POST", "/me/registration", { body: { display_name: name || me.display_name, guardian_attestation: guardian, adult_attestation: adult,
        consents: { CORE_PROCESSING: core, ANALYTICS: analytics, SMS_REMINDERS: sms, EMAIL_REMINDERS: false }, notice_version: me.privacy_notice_version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }, idempotent: false });
      router.replace("/babies/new?first=1");
    } catch (x) { setErr(errorText(x)); setFe(fieldErrors(x)); } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex max-w-md flex-col gap-5 px-6 py-8">
      <div><h1 className="text-3xl font-extrabold">Welcome</h1><p className="text-ink-2">A few things before you add your baby.</p></div>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Your name" required error={fe.display_name}>{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />}</Field>
        <Card className="flex flex-col gap-1">
          <Toggle checked={guardian} onChange={setGuardian} label="I am the parent or lawful guardian" description="You'll be recording health information about a child." />
          <Toggle checked={adult} onChange={setAdult} label="I am 18 or older" />
        </Card>
        <Card className="flex flex-col gap-2">
          <h2 className="font-bold">Privacy notice (version {me.privacy_notice_version})</h2>
          <p className="text-sm text-ink-2">We store your baby's records privately, in India, encrypted. We never sell data or show ads. You can export or delete everything at any time.</p>
          <a href="/privacy-notice" target="_blank" onClick={() => setRead(true)} className="text-sm font-semibold text-sage underline">Read the full privacy notice</a>
          <Toggle checked={core} onChange={(v) => setCore(v && read)} label="I consent to processing my child's health records to provide this service" description={read ? "Required to use the app. You can withdraw later." : "Open the privacy notice first."} />
          <Toggle checked={analytics} onChange={setAnalytics} label="Anonymous usage analytics (optional)" description="Aggregate, contains no health data." />
          <Toggle checked={sms} onChange={setSms} label="SMS / WhatsApp vaccine reminders (optional)" description="Generic text only." />
        </Card>
        {err && <Notice tone="allergy">{err}</Notice>}
        <Button type="submit" block busy={busy} disabled={!guardian || !adult || !core}>Continue</Button>
        <p className="text-xs text-ink-2">Grievance contact: {me.grievance_contact}</p>
      </form>
    </main>
  );
}
