import { DateTime } from "luxon";

/** Spec §21. All functions are pure; `now` and timezone are explicit. */
export type AgeInput = { birthDate: string; birthTime?: string | null; birthTz?: string | null };
export type Age = {
  totalDays: number;
  completedWeeks: number;
  remainingDays: number;
  completedMonths: number;
  monthRemainderDays: number;
  years: number;
  display: string;
  hoursOfLife: number | null;
  dayOfLife: number | null; // convention: day of birth = Day 1 (pending reviewer decision Q3; flagged in UI)
};

export class AgeError extends Error {
  constructor(public code: "INVALID_DATE" | "FUTURE_BIRTH_DATE" | "FUTURE_BIRTH_TIME" | "INVALID_TIMEZONE", msg: string) {
    super(msg);
  }
}

export function isValidIanaZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

/** Parses a strict YYYY-MM-DD calendar date; rejects impossible dates such as 2025-02-29. */
export function parseCalendarDate(s: string): DateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new AgeError("INVALID_DATE", `Invalid date: ${s}`);
  const d = DateTime.fromISO(s, { zone: "UTC" });
  if (!d.isValid || d.toISODate() !== s) throw new AgeError("INVALID_DATE", `Invalid date: ${s}`);
  return d;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDateOf(instant: Date | string, tz: string): string {
  const dt = typeof instant === "string" ? DateTime.fromISO(instant, { setZone: true }) : DateTime.fromJSDate(instant);
  const z = dt.setZone(tz);
  if (!z.isValid) throw new AgeError("INVALID_TIMEZONE", `Invalid timezone: ${tz}`);
  return z.toISODate()!;
}

/** Adds calendar months, clamping to the last valid day (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(isoDate: string, months: number): string {
  const d = parseCalendarDate(isoDate);
  return d.plus({ months }).toISODate()!; // luxon clamps day-of-month overflow
}

function daysBetween(a: string, b: string): number {
  return Math.round(parseCalendarDate(b).diff(parseCalendarDate(a), "days").days);
}

export function validateBirth(input: AgeInput, now: Date, householdTz: string) {
  parseCalendarDate(input.birthDate);
  if (!isValidIanaZone(householdTz)) throw new AgeError("INVALID_TIMEZONE", "Invalid household timezone");
  const birthTz = input.birthTz || "Asia/Kolkata";
  if (!isValidIanaZone(birthTz)) throw new AgeError("INVALID_TIMEZONE", "Invalid birth timezone");
  const today = localDateOf(now, householdTz);
  if (input.birthDate > today) throw new AgeError("FUTURE_BIRTH_DATE", "Date of birth can't be in the future");
  if (input.birthTime) {
    if (!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(input.birthTime)) throw new AgeError("INVALID_DATE", "Invalid birth time");
    const birthInstant = DateTime.fromISO(`${input.birthDate}T${input.birthTime.slice(0, 5)}`, { zone: birthTz });
    if (birthInstant.toMillis() > now.getTime() + 60_000) throw new AgeError("FUTURE_BIRTH_TIME", "Birth time can't be in the future");
  }
}

export function calculateAgeInDays(input: AgeInput, now: Date, householdTz: string): number {
  validateBirth(input, now, householdTz);
  return daysBetween(input.birthDate, localDateOf(now, householdTz));
}

export function calculateCompletedWeeks(input: AgeInput, now: Date, householdTz: string): number {
  return Math.floor(calculateAgeInDays(input, now, householdTz) / 7);
}

export function calculateBabyAge(input: AgeInput, now: Date, householdTz: string): Age {
  const totalDays = calculateAgeInDays(input, now, householdTz);
  const today = localDateOf(now, householdTz);
  let m = 0;
  while (addMonthsClamped(input.birthDate, m + 1) <= today) m++;
  const monthRemainderDays = daysBetween(addMonthsClamped(input.birthDate, m), today);
  const years = Math.floor(m / 12);
  const completedWeeks = Math.floor(totalDays / 7);
  const remainingDays = totalDays % 7;

  let hoursOfLife: number | null = null;
  if (input.birthTime && totalDays < 7) {
    const b = DateTime.fromISO(`${input.birthDate}T${input.birthTime.slice(0, 5)}`, { zone: input.birthTz || "Asia/Kolkata" });
    hoursOfLife = Math.max(0, Math.floor((now.getTime() - b.toMillis()) / 3_600_000));
  }
  return {
    totalDays,
    completedWeeks,
    remainingDays,
    completedMonths: m,
    monthRemainderDays,
    years,
    display: formatAge({ totalDays, completedWeeks, remainingDays, completedMonths: m, monthRemainderDays, years }),
    hoursOfLife,
    dayOfLife: totalDays + 1,
  };
}

export function formatAge(a: Pick<Age, "totalDays" | "completedWeeks" | "remainingDays" | "completedMonths" | "monthRemainderDays" | "years">): string {
  const p = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (a.totalDays === 0) return "Newborn — day of birth";
  if (a.completedMonths < 24) {
    if (a.completedWeeks === 0) return p(a.totalDays, "day");
    return a.remainingDays ? `${p(a.completedWeeks, "week")} ${p(a.remainingDays, "day")}` : p(a.completedWeeks, "week");
  }
  const months = a.completedMonths % 12;
  return months ? `${p(a.years, "year")} ${p(months, "month")}` : p(a.years, "year");
}
