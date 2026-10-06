"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText, ApiProblem } from "@/lib/api";
import { Button, Notice } from "@/components/ui";

export default function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function accept() {
    setBusy(true); setErr(null);
    try { const r = await api("POST", "/invitations/accept", { body: { token }, idempotent: false }); router.replace(`/babies/${r.baby_id}`); }
    catch (e) { if (e instanceof ApiProblem && e.status === 401) router.replace(`/login?next=/invite/${token}`); else setErr(errorText(e)); }
    finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-6">
      <h1 className="text-3xl font-extrabold">You've been invited</h1>
      <p className="text-ink-2">Someone shared a baby's health record with you. Sign in with the email or phone the invitation was sent to, then accept.</p>
      {err && <Notice tone="allergy">{err}</Notice>}
      <Button onClick={accept} busy={busy} block>Accept invitation</Button>
    </main>
  );
}
