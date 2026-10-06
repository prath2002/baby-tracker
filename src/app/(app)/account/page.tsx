"use client";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDateTime } from "@/lib/format";
import { Badge, Button, Card, Field, Input, Loading, PageHeader, useToast } from "@/components/ui";

/** Account (screen 33): profile, sign-in identity, sessions/devices. */
export default function Account() {
  const toast = useToast();
  const { data: me, reload } = useApi<any>("/me");
  const { data: sessions, reload: reloadS } = useApi<any[]>("/sessions");
  const [name, setName] = useState<string | null>(null);
  if (!me) return <Loading />;
  async function save() { try { await api("PATCH", "/me", { body: { display_name: name } }); invalidate("/me"); reload(); setName(null); toast({ text: "Saved" }); } catch (x) { toast({ text: errorText(x), tone: "error" }); } }
  async function revoke(id: string) { try { await api("DELETE", `/sessions/${id}`); reloadS(); toast({ text: "Device signed out" }); } catch (x) { toast({ text: errorText(x), tone: "error" }); } }
  return (
    <>
      <PageHeader title="Account" back="/settings" />
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col gap-3">
          <Field label="Your name">{(id) => <Input id={id} value={name ?? me.display_name} onChange={(e) => setName(e.target.value)} />}</Field>
          {name !== null && <Button onClick={save}>Save</Button>}
          <p className="text-sm">Signed in with: <b>{me.email ?? me.phone_e164}</b></p>
          <p className="text-sm text-ink-2">Households: {me.households.map((h: any) => `${h.name} (${h.timezone})`).join(", ")}</p>
        </Card>
        <Card>
          <h2 className="mb-2 font-bold">Devices & sessions</h2>
          <ul className="flex flex-col gap-2">{sessions?.map((s: any) => (
            <li key={s.id} className="flex items-center gap-2 rounded-2xl bg-sunken p-2 text-sm">
              <span className="flex-1"><span className="block font-semibold">{s.device_name ?? "Device"}</span><span className="text-ink-2">Last active {fmtDateTime(s.last_seen_at)}</span></span>
              {s.current ? <Badge tone="success">This device</Badge> : <Button variant="ghost" className="min-h-10 text-sm" onClick={() => revoke(s.id)}>Sign out</Button>}
            </li>))}</ul>
        </Card>
      </div>
    </>
  );
}
