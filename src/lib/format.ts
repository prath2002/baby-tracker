import { DateTime } from "luxon";

export const fmtDate = (iso: string | null | undefined) => (iso ? DateTime.fromISO(iso).toFormat("d LLL yyyy") : "—");
export const fmtDateTime = (iso: string | Date | null | undefined, tz?: string) => {
  if (!iso) return "—";
  const d = typeof iso === "string" ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso);
  return (tz ? d.setZone(tz) : d).toFormat("d LLL, h:mm a");
};
export const fmtTime = (iso: string | Date, tz?: string) => {
  const d = typeof iso === "string" ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso);
  return (tz ? d.setZone(tz) : d).toFormat("h:mm a");
};
export const fmtMl = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Number.isInteger(n) ? n : n.toFixed(1)} ml`);
export const fmtKg = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Number(n).toFixed(n < 10 ? 3 : 2).replace(/0+$/, "").replace(/\.$/, "")} kg`);
export const todayIn = (tz: string) => DateTime.now().setZone(tz).toISODate()!;
export const nowLocalInput = (tz?: string) => (tz ? DateTime.now().setZone(tz) : DateTime.now()).toFormat("yyyy-LL-dd'T'HH:mm");
export const localInputToIso = (v: string, tz: string) => DateTime.fromISO(v, { zone: tz }).toUTC().toISO()!;
export const isoToLocalInput = (iso: string, tz: string) => DateTime.fromISO(iso).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm");
export const titleCase = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
export const sentence = (s: string) => { const t = s.toLowerCase().replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
