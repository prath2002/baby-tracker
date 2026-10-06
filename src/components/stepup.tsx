"use client";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { Button, Field, Input, Notice, Sheet } from "./ui";

/** Step-up verification sheet used before sensitive actions: account password if set, otherwise a one-time code. */
export function StepUpSheet({ open, onDone, onClose, me }: { open: boolean; onDone: () => void; onClose: () => void; me: { email?: string | null; phone_e164?: string | null; has_password?: boolean } }) {
  const identifier = me.email ? { email: me.email } : { phone_e164: me.phone_e164 ?? undefined };
  const [useCode, setUseCode] = useState(!me.has_password);
  const [ch, setCh] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function send() { setErr(null); try { const r = await api("POST", "/auth/otp/request", { body: { ...identifier, purpose: "STEP_UP" }, idempotent: false }); setCh(r.challenge_id); } catch (x) { setErr(errorText(x)); } }
  async function verify() { setErr(null); try { await api("POST", "/auth/otp/verify", { body: { challenge_id: ch, code }, idempotent: false }); setCh(null); setCode(""); onDone(); } catch (x) { setErr(errorText(x)); } }
  async function verifyPassword(e: React.FormEvent) { e.preventDefault(); setErr(null); try { await api("POST", "/auth/password/step-up", { body: { password }, idempotent: false }); setPassword(""); onDone(); } catch (x) { setErr(errorText(x)); } }
  return (
    <Sheet open={open} onClose={onClose} title="Confirm it's you">
      <div className="flex flex-col gap-3">
        {!useCode ? <form onSubmit={verifyPassword} className="flex flex-col gap-3">
          <p className="text-sm">For your baby's safety, sensitive actions need your password again.</p>
          <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          <Button type="submit" disabled={!password}>Confirm</Button>
          <button type="button" className="min-h-12 text-sm font-semibold text-sage" onClick={() => { setUseCode(true); setErr(null); }}>Use a one-time code instead</button>
        </form> : <>
          <p className="text-sm">For your baby's safety, sensitive actions need a fresh one-time code.</p>
          {!ch ? <Button onClick={send}>Send code to {identifier.email ?? identifier.phone_e164}</Button> : <>
            <Field label="6-digit code">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} />}</Field>
            <Button onClick={verify} disabled={code.length !== 6}>Verify</Button></>}
          {me.has_password && <button type="button" className="min-h-12 text-sm font-semibold text-sage" onClick={() => { setUseCode(false); setErr(null); }}>Use your password instead</button>}
        </>}
        {err && <Notice tone="allergy">{err}</Notice>}
      </div>
    </Sheet>
  );
}
