"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { cx, Sheet } from "./ui";
import { api } from "@/lib/api";
import { useApi } from "@/lib/useApi";

export type Baby = {
  id: string; first_name: string; nickname: string | null; colour_token: string; sex: string; birth_date: string; birth_time: string | null;
  household_id: string; household_timezone: string; my_role: string; can_view_documents: boolean; photo_document_id: string | null; version: number;
  age: { display: string; totalDays: number; completedWeeks: number; remainingDays: number; completedMonths: number; monthRemainderDays: number; dayOfLife: number };
  categories: string[]; allergies: { id: string; substance: string; status: string; severity_reported: string }[]; nka_confirmed_at: string | null;
  profile: Record<string, any> | null; schedule: { schedule_id: string; je_opt_in: boolean } | null;
};

export const COLOUR: Record<string, { fill: string; ink: string; name: string }> = {
  PEACH: { fill: "var(--peach)", ink: "var(--peach-ink)", name: "Peach" }, SKY: { fill: "var(--sky)", ink: "var(--sky-ink)", name: "Sky" },
  MINT: { fill: "var(--mint)", ink: "var(--mint-ink)", name: "Mint" }, LILAC: { fill: "var(--lilac)", ink: "var(--lilac-ink)", name: "Lilac" },
  BUTTER: { fill: "var(--butter)", ink: "var(--butter-ink)", name: "Butter" }, ROSE: { fill: "var(--rose)", ink: "var(--rose-ink)", name: "Rose" },
};
export const displayName = (b: Pick<Baby, "first_name" | "nickname">) => (b.nickname ? `${b.first_name} (${b.nickname})` : b.first_name);

export function BabyAvatar({ baby, size = 48 }: { baby: Pick<Baby, "id" | "first_name" | "colour_token" | "photo_document_id">; size?: number }) {
  const c = COLOUR[baby.colour_token] ?? COLOUR.MINT;
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (baby.photo_document_id) api<{ url: string | null }>("GET", `/babies/${baby.id}/photo-url`).then((r) => alive && setUrl(r.url)).catch(() => {});
    return () => { alive = false; };
  }, [baby.id, baby.photo_document_id]);
  return (
    <span aria-hidden className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-display font-extrabold"
      style={{ width: size, height: size, background: c.fill, color: c.ink, boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${c.ink}`, fontSize: size * 0.42 }}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : baby.first_name.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Persistent identity bar shown on every create/edit screen (spec §32.2). */
export function BabyIdentityBar({ baby, changeHref }: { baby: Baby; changeHref?: string }) {
  const c = COLOUR[baby.colour_token] ?? COLOUR.MINT;
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 flex items-center gap-3 border-b px-4 py-2 backdrop-blur" style={{ background: `color-mix(in srgb, ${c.fill} 55%, var(--canvas))`, borderColor: c.ink }}>
      <BabyAvatar baby={baby} size={40} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display text-lg font-extrabold" style={{ color: "var(--ink)" }}>For {displayName(baby)}</p>
        <p className="text-sm text-ink-2">{baby.age.display}</p>
      </div>
      {changeHref && <Link href={changeHref} className="min-h-10 rounded-full border border-line bg-surface px-3 py-2 text-sm font-semibold">Change baby</Link>}
    </div>
  );
}

/** Allergy banner — icon + text, never colour alone (spec §29). */
export function AllergyBanner({ baby }: { baby: Pick<Baby, "allergies" | "nka_confirmed_at" | "id"> }) {
  if (!baby.allergies.length)
    return <p className="rounded-2xl bg-sunken px-3 py-2 text-sm text-ink-2">⚕︎ {baby.nka_confirmed_at ? "No known allergies (confirmed)" : "No allergies recorded"}</p>;
  return (
    <Link href={`/babies/${baby.id}/allergies`} role="alert" className="flex items-start gap-2 rounded-2xl bg-allergy-bg px-3 py-2 text-allergy">
      <span aria-hidden className="text-lg">⚠︎</span>
      <span className="text-sm font-semibold">Allergies: {baby.allergies.map((a) => `${a.substance} (${a.status === "CONFIRMED_BY_DOCTOR" ? "confirmed" : "suspected"})`).join(", ")}</span>
    </Link>
  );
}

export function useBaby(babyId: string) {
  const r = useApi<Baby>(`/babies/${babyId}`);
  return r;
}

/** Explicit baby picker — never defaults when more than one baby exists (spec §32.1). */
export function BabyPicker({ open, onClose, onPick, title = "Who is this for?" }: { open: boolean; onClose: () => void; onPick: (b: Baby) => void; title?: string }) {
  const { data } = useApi<{ data: Baby[] }>(open ? "/babies" : null);
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      <ul className="flex flex-col gap-2">
        {(data?.data ?? []).map((b) => (
          <li key={b.id}>
            <button onClick={() => onPick(b)} className="flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 border-transparent bg-sunken px-3 py-2 text-left hover:border-sage">
              <BabyAvatar baby={b} />
              <span className="flex-1"><span className="block font-bold">{displayName(b)}</span><span className="text-sm text-ink-2">{b.age.display} · born {b.birth_date}</span></span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function BabyChip({ name, colour }: { name: string; colour: string }) {
  const c = COLOUR[colour] ?? COLOUR.MINT;
  return <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: c.fill, color: c.ink }}>{name}</span>;
}

export function BabyNav({ babyId, active }: { babyId: string; active: string }) {
  const items: [string, string][] = [["", "Overview"], ["milk", "Milk"], ["excretions", "Excretions"], ["weight", "Weight"], ["growth", "Growth"], ["vaccinations", "Vaccines"], ["appointments", "Visits"],
    ["medicines", "Medicines"], ["prescriptions", "Prescriptions"], ["allergies", "Allergies"], ["documents", "Documents"], ["timeline", "Timeline"], ["summary/daily", "Summaries"], ["profile", "Profile"]];
  return (
    <nav aria-label="Baby sections" className="-mx-4 mb-4 overflow-x-auto px-4">
      <ul className="flex gap-2 whitespace-nowrap">
        {items.map(([p, l]) => (
          <li key={p}><Link href={`/babies/${babyId}${p ? "/" + p : ""}`} aria-current={active === p ? "page" : undefined}
            className={cx("inline-flex min-h-10 items-center rounded-full px-3 text-sm font-semibold", active === p ? "bg-ink text-canvas" : "bg-surface text-ink-2 border border-line")}>{l}</Link></li>
        ))}
      </ul>
    </nav>
  );
}

export function RoleNote({ role, need, children }: { role: string; need: "LOG" | "MANAGE"; children?: ReactNode }) {
  const ok = need === "LOG" ? ["OWNER", "GUARDIAN", "CAREGIVER"].includes(role) : ["OWNER", "GUARDIAN"].includes(role);
  if (ok) return <>{children}</>;
  return <p className="rounded-2xl bg-sunken p-3 text-sm text-ink-2">Your role ({role.toLowerCase()}) can view but not change this.</p>;
}
export const canLog = (role: string) => ["OWNER", "GUARDIAN", "CAREGIVER"].includes(role);
export const canManage = (role: string) => ["OWNER", "GUARDIAN"].includes(role);
