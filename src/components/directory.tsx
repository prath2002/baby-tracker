"use client";
import { useState } from "react";
import { api, errorText } from "@/lib/api";
import { invalidate, useApi } from "@/lib/useApi";
import { Button, Field, Input, Select } from "./ui";

/** Doctor / clinic picker with inline create (household directory). */
export function DirectoryPicker({ householdId, kind, value, onChange, canCreate }: { householdId: string; kind: "doctors" | "clinics"; value: string; onChange: (id: string) => void; canCreate: boolean }) {
  const path = `/households/${householdId}/${kind}`;
  const { data, reload } = useApi<any>(path);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [extra, setExtra] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const label = kind === "doctors" ? "Doctor" : "Clinic / hospital";
  async function add() {
    setErr(null);
    try {
      const r = await api("POST", path, { body: kind === "doctors" ? { name, specialty: extra || null } : { name, address: extra || null } });
      invalidate(path); await reload(); onChange(r.id); setAdding(false); setName(""); setExtra("");
    } catch (e) { setErr(errorText(e)); }
  }
  return (
    <div className="flex flex-col gap-2">
      <Field label={label}>{(id) => <Select id={id} value={value} onChange={(e) => (e.target.value === "__new" ? setAdding(true) : onChange(e.target.value))}>
        <option value="">— None —</option>{data?.data?.map((d: any) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` · ${d.specialty}` : ""}</option>)}{canCreate && <option value="__new">+ Add new…</option>}</Select>}</Field>
      {adding && <div className="flex flex-col gap-2 rounded-2xl bg-sunken p-3">
        <Field label={`${label} name`}>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={kind === "doctors" ? "Specialty (optional)" : "Address (optional)"}>{(id) => <Input id={id} value={extra} onChange={(e) => setExtra(e.target.value)} />}</Field>
        {err && <p className="text-sm text-allergy">{err}</p>}
        <div className="flex gap-2"><Button type="button" onClick={add} disabled={!name}>Add</Button><Button type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
      </div>}
    </div>
  );
}
