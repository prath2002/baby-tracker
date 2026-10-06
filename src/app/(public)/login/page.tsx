"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { Button, Field, Input, Notice, Segmented } from "@/components/ui";

/** Login (screen 3): email + password, or an email/phone one-time code. */
function LoginInner() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [method, setMethod] = useState<"PASSWORD" | "CODE">("PASSWORD");
  const [creating, setCreating] = useState(false);
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"EMAIL" | "PHONE">("EMAIL");
  const [id, setId] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [resendAt, setResendAt] = useState(0);

  const identifier = () => (mode === "EMAIL" ? { email: id.trim() } : { phone_e164: id.trim().startsWith("+") ? id.trim().replace(/\s/g, "") : `+91${id.replace(/\D/g, "")}` });
  async function request(e?: React.FormEvent) {
    e?.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api("POST", "/auth/otp/request", { body: identifier(), idempotent: false }); setChallenge(r.challenge_id); setResendAt(Date.now() + r.resend_after_s * 1000); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  function signedIn(r: { registration_complete: boolean }) {
    try { localStorage.setItem("bh_onboarded", "1"); } catch {}
    router.replace(r.registration_complete ? (next && next.startsWith("/") && !next.startsWith("//") ? next : "/home") : "/register");
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { signedIn(await api("POST", "/auth/otp/verify", { body: { challenge_id: challenge, code, device_name: navigator.userAgent.slice(0, 60) }, idempotent: false })); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  async function passwordSubmit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { signedIn(await api("POST", creating ? "/auth/password/register" : "/auth/password/login", { body: { email: id.trim(), password, device_name: navigator.userAgent.slice(0, 60) }, idempotent: false })); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-6 py-10">
      <div><h1 className="text-3xl font-extrabold">{method === "PASSWORD" && creating ? "Create account" : "Sign in"}</h1>
        <p className="text-ink-2">{method === "PASSWORD" ? "Use your email and password." : "We'll send you a 6-digit code. No password needed."}</p></div>
      {method === "PASSWORD" ? (
        <form onSubmit={passwordSubmit} className="flex flex-col gap-4">
          <Field label="Email address">
            {(fid, d) => <Input id={fid} aria-describedby={d} required value={id} onChange={(e) => setId(e.target.value)} type="email" autoComplete="email" inputMode="email" />}
          </Field>
          <Field label="Password" hint={creating ? "At least 10 characters." : undefined}>
            {(fid, d) => <Input id={fid} aria-describedby={d} required value={password} onChange={(e) => setPassword(e.target.value)} type="password" minLength={creating ? 10 : undefined} maxLength={200} autoComplete={creating ? "new-password" : "current-password"} />}
          </Field>
          {err && <Notice tone="allergy">{err}</Notice>}
          <Button type="submit" busy={busy} block>{creating ? "Create account" : "Sign in"}</Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="min-h-12 font-semibold text-sage" onClick={() => { setCreating(!creating); setErr(null); }}>{creating ? "I have an account" : "Create an account"}</button>
            <button type="button" className="min-h-12 font-semibold text-sage" onClick={() => { setMethod("CODE"); setErr(null); }}>Use a one-time code</button>
          </div>
        </form>
      ) : !challenge ? (
        <form onSubmit={request} className="flex flex-col gap-4">
          <Segmented label="Sign in with" value={mode} onChange={(v) => { setMode(v); setId(""); }} options={[{ value: "EMAIL", label: "Email" }, { value: "PHONE", label: "Phone" }]} />
          <Field label={mode === "EMAIL" ? "Email address" : "Mobile number"} hint={mode === "PHONE" ? "Indian numbers can be entered without +91." : undefined}>
            {(fid, d) => <Input id={fid} aria-describedby={d} required value={id} onChange={(e) => setId(e.target.value)} type={mode === "EMAIL" ? "email" : "tel"} autoComplete={mode === "EMAIL" ? "email" : "tel"} inputMode={mode === "EMAIL" ? "email" : "tel"} />}
          </Field>
          {err && <Notice tone="allergy">{err}</Notice>}
          <Button type="submit" busy={busy} block>Send code</Button>
          <button type="button" className="min-h-12 text-sm font-semibold text-sage" onClick={() => { setMethod("PASSWORD"); setMode("EMAIL"); setErr(null); }}>Use email and password</button>
        </form>
      ) : (
        <form onSubmit={verify} className="flex flex-col gap-4">
          <Field label="6-digit code" hint={`Sent to ${id}. It expires in 5 minutes.`}>
            {(fid, d) => <Input id={fid} aria-describedby={d} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" className="num text-center text-2xl tracking-[0.4em]" />}
          </Field>
          {err && <Notice tone="allergy">{err}</Notice>}
          <Button type="submit" busy={busy} block disabled={code.length !== 6}>Verify and continue</Button>
          <div className="flex justify-between text-sm">
            <button type="button" className="min-h-12 font-semibold text-sage" onClick={() => { setChallenge(null); setCode(""); }}>Change {mode === "EMAIL" ? "email" : "number"}</button>
            <button type="button" className="min-h-12 font-semibold text-sage disabled:opacity-50" disabled={Date.now() < resendAt || busy} onClick={() => request()}>Resend code</button>
          </div>
        </form>
      )}
      <p className="text-xs text-ink-2">By continuing you agree to our <a className="underline" href="/privacy-notice">privacy notice</a>.</p>
    </main>
  );
}
export default function Login() { return <Suspense><LoginInner /></Suspense>; }
