"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { Button, Card, Field, Input, ListRow, Loading, Notice, PageHeader, Segmented, Select, Toggle, useToast } from "@/components/ui";

const urlB64 = (s: string) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const b = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from([...b].map((c) => c.charCodeAt(0))); };

/** Settings (screen 32). */
export default function Settings() {
  const toast = useToast();
  const { data: s, reload } = useApi<any>("/me/settings");
  const { data: me } = useApi<any>("/me");
  const [push, setPush] = useState<"unsupported" | "off" | "on">("off");
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { setPush("unsupported"); return; }
    navigator.serviceWorker.getRegistration().then((r) => r?.pushManager.getSubscription()).then((sub) => setPush(sub ? "on" : "off")).catch(() => {});
  }, []);
  if (!s || !me) return <Loading />;
  async function patch(b: Record<string, unknown>) {
    try { await api("PATCH", "/me/settings", { body: b }); invalidate("/"); reload(); toast({ text: "Saved" }); } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function enablePush() {
    try {
      if (!me.vapid_public_key) { toast({ text: "Push notifications aren't configured on this server yet.", tone: "error" }); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return;
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(me.vapid_public_key) });
      await api("POST", "/devices", { body: sub.toJSON(), idempotent: false }); setPush("on"); toast({ text: "Notifications enabled on this device" });
    } catch (x) { toast({ text: errorText(x), tone: "error" }); }
  }
  async function disablePush() {
    const reg = await navigator.serviceWorker.getRegistration(); const sub = await reg?.pushManager.getSubscription();
    if (sub) { await api("DELETE", "/devices", { body: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
    setPush("off");
  }
  const setTheme = (t: string) => { try { localStorage.setItem("bh_theme", t); } catch {} document.documentElement.dataset.theme = t === "SYSTEM" ? "" : t.toLowerCase(); patch({ theme: t }); };
  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <h2 className="font-bold">Display</h2>
          <div><p className="mb-1.5 text-sm font-semibold">Theme</p><Segmented label="Theme" value={s.theme} onChange={setTheme} options={[{ value: "SYSTEM", label: "Auto" }, { value: "LIGHT", label: "Light" }, { value: "DARK", label: "Dark" }]} /></div>
          <div><p className="mb-1.5 text-sm font-semibold">Default milk unit</p><Segmented label="Volume unit" value={s.volume_unit} onChange={(v) => patch({ volume_unit: v })} options={[{ value: "ML", label: "ml" }, { value: "OZ", label: "oz" }]} /></div>
          <Field label="Household timezone" hint="Days and ages follow this timezone, even when you travel.">{(id, d) => <Select id={id} aria-describedby={d} value={s.household_timezone} onChange={(e) => patch({ household_timezone: e.target.value })}>{["Asia/Kolkata", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York", "America/Los_Angeles", "Australia/Sydney"].map((z) => <option key={z}>{z}</option>)}</Select>}</Field>
        </Card>
        <Card className="flex flex-col gap-2" aria-label="Notifications">
          <h2 id="notifications" className="font-bold">Notifications</h2>
          {push === "unsupported" ? <Notice>This browser doesn't support push notifications. Install the app to your home screen (iPhone: Share → Add to Home Screen) and try again. Reminders still appear in the in-app inbox.</Notice>
            : <Toggle checked={push === "on"} onChange={(v) => (v ? enablePush() : disablePush())} label="Push notifications on this device" description="Reminders never include health details on the lock screen." />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quiet hours from">{(id) => <Input id={id} type="time" value={s.quiet_hours.start} onChange={(e) => patch({ quiet_hours: { ...s.quiet_hours, start: e.target.value } })} />}</Field>
            <Field label="until">{(id) => <Input id={id} type="time" value={s.quiet_hours.end} onChange={(e) => patch({ quiet_hours: { ...s.quiet_hours, end: e.target.value } })} />}</Field>
          </div>
          <Toggle checked={s.lockscreen_privacy === "HIDE_NAME"} onChange={(v) => patch({ lockscreen_privacy: v ? "HIDE_NAME" : "SHOW_NAME" })} label="Hide baby names in notifications" />
          {push === "on" && <Button variant="secondary" onClick={() => api("POST", "/devices/test", { idempotent: false }).then(() => toast({ text: "Test sent" })).catch((x) => toast({ text: errorText(x), tone: "error" }))}>Send a test notification</Button>}
        </Card>
        <Card className="p-1">
          <ListRow href="/account" title="Account & devices" sub="Name, sign-in, sessions" right="›" />
          <ListRow href="/privacy" title="Privacy & security" sub="Consents, access log, deletion" right="›" />
          <ListRow href="/export" title="Export data" sub="PDF visit summary, JSON, CSV" right="›" />
          <ListRow href="/sources" title="Medical sources" sub="Where reference information comes from" right="›" />
        </Card>
        <Button variant="ghost" onClick={async () => { await api("POST", "/auth/logout", { idempotent: false }).catch(() => {}); location.href = "/login"; }}>Sign out</Button>
        <p className="text-center text-xs text-ink-2">Baby Health · reference information only, not a substitute for pediatric care. <Link className="underline" href="/privacy-notice">Privacy notice</Link></p>
      </div>
    </>
  );
}
