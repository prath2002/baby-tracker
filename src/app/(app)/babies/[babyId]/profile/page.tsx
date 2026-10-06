"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { fmtDate } from "@/lib/format";
import { Badge, Button, Card, ErrorState, Field, Input, ListRow, Loading, Notice, PageHeader, Segmented, Select, Sheet, Toggle, useToast } from "@/components/ui";
import { AllergyBanner, BabyNav, COLOUR, canManage, useBaby } from "@/components/baby";

/** Baby Profile (screen 7) incl. members & sharing. */
export default function Profile({ params }: { params: Promise<{ babyId: string }> }) {
  const { babyId } = use(params);
  const router = useRouter();
  const toast = useToast();
  const { data: baby, error, reload } = useBaby(babyId);
  const { data: members, reload: reloadMembers } = useApi<any>(`/babies/${babyId}/members`);
  const [edit, setEdit] = useState(false);
  const [invite, setInvite] = useState(false);
  const [inv, setInv] = useState({ email: "", role: "CAREGIVER", docs: false });
  const [link, setLink] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!baby) return <Loading />;
  const p = baby.profile ?? {};
  const manage = canManage(baby.my_role);

  async function saveProfile(patch: Record<string, unknown>) {
    try { await api("PATCH", `/babies/${babyId}/profile`, { body: patch, ifMatch: p.version }); invalidate(`/babies/${babyId}`); reload(); toast({ text: "Profile updated" }); }
    catch (e) { toast({ text: errorText(e), tone: "error" }); }
  }
  async function saveBaby(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      await api("PATCH", `/babies/${babyId}`, { ifMatch: baby!.version, body: { first_name: form.first_name, nickname: form.nickname || null, sex: form.sex, birth_date: form.birth_date, birth_time: form.birth_time || null, colour_token: form.colour_token } });
      if (form.birth_weight !== String(p.birth_weight_kg ?? "") || form.ga_weeks !== String(p.ga_weeks ?? ""))
        await api("PATCH", `/babies/${babyId}/profile`, { ifMatch: p.version, body: { birth_weight_kg: form.birth_weight ? Number(form.birth_weight) : null, ga_weeks: form.ga_weeks ? Number(form.ga_weeks) : null, ga_days: form.ga_weeks ? Number(form.ga_days || 0) : null } });
      invalidate("/"); reload(); setEdit(false); toast({ text: "Saved" });
    } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  async function sendInvite(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api("POST", `/babies/${babyId}/members`, { body: { email: inv.email, role: inv.role, can_view_documents: inv.docs } }); setLink(r.invite_link); reloadMembers(); }
    catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Profile" back={`/babies/${babyId}`} action={manage && <Button variant="secondary" className="min-h-10 px-4 text-sm" onClick={() => { setForm({ first_name: baby.first_name, nickname: baby.nickname ?? "", sex: baby.sex, birth_date: baby.birth_date, birth_time: baby.birth_time ?? "", colour_token: baby.colour_token, birth_weight: String(p.birth_weight_kg ?? ""), ga_weeks: String(p.ga_weeks ?? ""), ga_days: String(p.ga_days ?? "") }); setEdit(true); }}>Edit</Button>} />
      <BabyNav babyId={babyId} active="profile" />
      <div className="flex flex-col gap-4">
        <AllergyBanner baby={baby} />
        <Card>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-2">Date of birth</dt><dd>{fmtDate(baby.birth_date)}{baby.birth_time ? `, ${baby.birth_time}` : " (time not recorded)"}</dd>
            <dt className="text-ink-2">Age</dt><dd>{baby.age.display} ({baby.age.totalDays} days)</dd>
            <dt className="text-ink-2">Sex</dt><dd>{baby.sex === "NOT_STATED" ? "Not stated" : baby.sex === "FEMALE" ? "Girl" : "Boy"}</dd>
            <dt className="text-ink-2">Birth weight</dt><dd>{p.birth_weight_kg != null ? `${p.birth_weight_kg} kg` : "Not recorded"}</dd>
            <dt className="text-ink-2">Gestational age</dt><dd>{p.ga_unknown ? "Unknown" : p.ga_weeks != null ? `${p.ga_weeks} weeks ${p.ga_days ?? 0} days` : "Not recorded"}</dd>
            <dt className="text-ink-2">Category</dt><dd>{baby.categories.length ? baby.categories.map((c) => <Badge key={c} tone="info">{c.replace(/_/g, " ").toLowerCase()}</Badge>) : "—"} <span className="text-xs text-ink-2">(WHO definitions)</span></dd>
            <dt className="text-ink-2">Vaccine schedule</dt><dd>{baby.schedule?.schedule_id === "IAP_RECOMMENDED_SCHEDULE" ? "IAP" : "Government of India (UIP)"}</dd>
            <dt className="text-ink-2">Your role</dt><dd>{baby.my_role.toLowerCase()}</dd>
          </dl>
        </Card>
        {manage && (
          <Card>
            <Toggle checked={!!p.show_clinical_references} onChange={(v) => saveProfile({ show_clinical_references: v })} label="Show clinical references"
              description="For babies with a documented clinical population (e.g. low birth weight). Shows sourced clinical references labelled 'Clinical reference' — never a personal target. Your care team's plan always comes first." />
            <Toggle checked={false} onChange={() => toast({ text: "Corrected age is pending pediatric review and is not available yet." })} label="Show corrected age (preterm)" description="Pending pediatric review." />
          </Card>
        )}
        <Card>
          <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">People with access</h2>{baby.my_role === "OWNER" && <Button variant="ghost" className="min-h-10 px-3 text-sm" onClick={() => { setInvite(true); setLink(null); }}>+ Invite</Button>}</div>
          <ul>{members?.members?.map((m: any) => <li key={m.user_id}><ListRow title={m.display_name} sub={`${m.role.toLowerCase()}${m.role === "CAREGIVER" || m.role === "VIEWER" ? (m.can_view_documents ? " · can view documents" : " · no document access") : ""}`} /></li>)}</ul>
          {members?.invitations?.length > 0 && <p className="mt-2 text-sm text-ink-2">Pending invitations: {members.invitations.map((i: any) => `${i.identifier} (${i.role.toLowerCase()})`).join(", ")}</p>}
        </Card>
        {baby.my_role === "OWNER" && <Button variant="secondary" onClick={() => router.push(`/privacy?delete_baby=${babyId}`)}>Delete {baby.first_name}'s records…</Button>}
      </div>
      <Sheet open={edit} onClose={() => setEdit(false)} title="Edit profile">
        {form && <form onSubmit={saveBaby} className="flex flex-col gap-3">
          <Field label="First name">{(id) => <Input id={id} value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} />}</Field>
          <Field label="Nickname">{(id) => <Input id={id} value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} />}</Field>
          <Segmented label="Sex" value={form.sex} onChange={(v) => setForm({ ...form, sex: v })} options={[{ value: "FEMALE", label: "Girl" }, { value: "MALE", label: "Boy" }, { value: "NOT_STATED", label: "Not stated" }]} />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date of birth" hint="Changing this changes age-based items">{(id, d) => <Input id={id} aria-describedby={d} type="date" value={form.birth_date} onChange={(e) => setForm({ ...form, birth_date: e.target.value })} />}</Field>
            <Field label="Time of birth">{(id) => <Input id={id} type="time" value={form.birth_time} onChange={(e) => setForm({ ...form, birth_time: e.target.value })} />}</Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Birth wt (kg)">{(id) => <Input id={id} inputMode="decimal" value={form.birth_weight} onChange={(e) => setForm({ ...form, birth_weight: e.target.value })} />}</Field>
            <Field label="GA weeks">{(id) => <Input id={id} inputMode="numeric" value={form.ga_weeks} onChange={(e) => setForm({ ...form, ga_weeks: e.target.value })} />}</Field>
            <Field label="+ days">{(id) => <Input id={id} inputMode="numeric" value={form.ga_days} onChange={(e) => setForm({ ...form, ga_days: e.target.value })} />}</Field>
          </div>
          <Field label="Colour">{(id) => <Select id={id} value={form.colour_token} onChange={(e) => setForm({ ...form, colour_token: e.target.value })}>{Object.entries(COLOUR).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}</Select>}</Field>
          {err && <Notice tone="allergy">{err}</Notice>}
          <Button type="submit" busy={busy}>Save</Button>
        </form>}
      </Sheet>
      <Sheet open={invite} onClose={() => setInvite(false)} title="Invite someone">
        {link ? <div className="flex flex-col gap-3"><Notice>Invitation created. We emailed it; you can also share this link (valid 7 days):</Notice><code className="break-all rounded-xl bg-sunken p-3 text-sm">{link}</code><Button onClick={() => navigator.clipboard?.writeText(link)}>Copy link</Button></div> : (
          <form onSubmit={sendInvite} className="flex flex-col gap-3">
            <Field label="Their email">{(id) => <Input id={id} type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />}</Field>
            <Segmented label="Role" value={inv.role} onChange={(v) => setInv({ ...inv, role: v })} options={[{ value: "GUARDIAN", label: "Co-parent" }, { value: "CAREGIVER", label: "Caregiver" }, { value: "VIEWER", label: "View only" }]} />
            <p className="text-sm text-ink-2">{inv.role === "GUARDIAN" ? "Full access except deleting the baby or managing people." : inv.role === "CAREGIVER" ? "Can log feeds, weights and medicine doses." : "Can view records only."}</p>
            {inv.role !== "GUARDIAN" && <Toggle checked={inv.docs} onChange={(v) => setInv({ ...inv, docs: v })} label="Allow viewing medical documents" />}
            {err && <Notice tone="allergy">{err}</Notice>}
            <Button type="submit" busy={busy}>Send invitation</Button>
          </form>)}
      </Sheet>
    </>
  );
}
