/** Measured-milk arithmetic (spec §20). Pure functions over recorded feeds. Never imputes, never converts BF to ml. */
export type FeedingType = "DIRECT_BREASTFEEDING" | "EXPRESSED_BREASTMILK" | "FORMULA" | "OTHER";
export const FEEDING_TYPES: FeedingType[] = ["DIRECT_BREASTFEEDING", "EXPRESSED_BREASTMILK", "FORMULA", "OTHER"];
export const ML_PER_US_FL_OZ = 29.5735;

export type FeedLike = {
  feeding_type: FeedingType;
  quantity_ml: number | string | null;
  local_date: string;
  occurred_at: string | Date;
};

export const ozToMl = (oz: number) => Math.round(oz * ML_PER_US_FL_OZ * 10) / 10;
export const mlToOz = (ml: number) => Math.round((ml / ML_PER_US_FL_OZ) * 100) / 100;
const num = (v: number | string | null) => (v === null || v === undefined ? null : Number(v));
const round1 = (n: number) => Math.round(n * 10) / 10;

export type DayMilk = {
  localDate: string;
  dataStatus: "NO_DATA" | "RECORDED";
  measuredMl: number | null; // null => NOT_AVAILABLE (no measurable feeds recorded)
  measuredMlByType: { EXPRESSED_BREASTMILK: number; FORMULA: number };
  measuredFeedCount: number;
  directBreastfeedingSessions: number;
  otherCount: number;
  feedCountByType: Record<FeedingType, number>;
  totalFeedCount: number;
  averageMeasuredFeedMl: number | null;
  firstFeedAt: string | null;
  lastFeedAt: string | null;
  messages: string[];
};

export function calculateDailyMeasuredMilk(feeds: FeedLike[], localDate: string): DayMilk {
  const day = feeds.filter((f) => f.local_date === localDate);
  const byType: Record<FeedingType, number> = { DIRECT_BREASTFEEDING: 0, EXPRESSED_BREASTMILK: 0, FORMULA: 0, OTHER: 0 };
  const measured = { EXPRESSED_BREASTMILK: 0, FORMULA: 0 };
  let measuredCount = 0;
  for (const f of day) {
    byType[f.feeding_type]++;
    if ((f.feeding_type === "EXPRESSED_BREASTMILK" || f.feeding_type === "FORMULA") && num(f.quantity_ml) !== null) {
      measured[f.feeding_type] += num(f.quantity_ml)!;
      measuredCount++;
    }
  }
  const measuredMl = measuredCount ? round1(measured.EXPRESSED_BREASTMILK + measured.FORMULA) : null;
  const times = day.map((f) => new Date(f.occurred_at).toISOString()).sort();
  const bf = byType.DIRECT_BREASTFEEDING;
  const messages: string[] = [];
  if (day.length === 0) messages.push("No feeds recorded.");
  else {
    if (measuredMl !== null) messages.push(`${formatMl(measuredMl)} measurable milk recorded.`);
    else messages.push("Measured milk: not available (no expressed milk or formula with a recorded amount).");
    if (bf > 0 && measuredMl !== null) messages.push("Additional direct breastfeeding sessions were recorded but not converted to volume.");
    if (bf > 0 && measuredMl === null) messages.push("Direct breastfeeding volume cannot be reliably measured from duration alone.");
  }
  return {
    localDate,
    dataStatus: day.length ? "RECORDED" : "NO_DATA",
    measuredMl,
    measuredMlByType: { EXPRESSED_BREASTMILK: round1(measured.EXPRESSED_BREASTMILK), FORMULA: round1(measured.FORMULA) },
    measuredFeedCount: measuredCount,
    directBreastfeedingSessions: bf,
    otherCount: byType.OTHER,
    feedCountByType: byType,
    totalFeedCount: day.length,
    averageMeasuredFeedMl: measuredCount ? round1((measured.EXPRESSED_BREASTMILK + measured.FORMULA) / measuredCount) : null,
    firstFeedAt: times[0] ?? null,
    lastFeedAt: times[times.length - 1] ?? null,
    messages,
  };
}

export type RangeMilk = {
  days: DayMilk[];
  totalMeasuredMl: number | null;
  daysWithMeasuredData: number;
  daysWithAnyData: number;
  avgMeasuredMlPerDayWithData: number | null;
  directBreastfeedingSessions: number;
  totalFeeds: number;
  feedsPerDayAvg: number | null; // over days with any data
  dataStatus: "NO_DATA" | "PARTIAL_DATA" | "RECORDED";
};

export function calculateRangeMeasuredMilk(feeds: FeedLike[], localDates: string[]): RangeMilk {
  const days = localDates.map((d) => calculateDailyMeasuredMilk(feeds, d));
  const withMeasured = days.filter((d) => d.measuredMl !== null);
  const withAny = days.filter((d) => d.dataStatus === "RECORDED");
  const total = withMeasured.reduce((s, d) => s + (d.measuredMl ?? 0), 0);
  const totalFeeds = days.reduce((s, d) => s + d.totalFeedCount, 0);
  return {
    days,
    totalMeasuredMl: withMeasured.length ? round1(total) : null,
    daysWithMeasuredData: withMeasured.length,
    daysWithAnyData: withAny.length,
    avgMeasuredMlPerDayWithData: withMeasured.length ? round1(total / withMeasured.length) : null,
    directBreastfeedingSessions: days.reduce((s, d) => s + d.directBreastfeedingSessions, 0),
    totalFeeds,
    feedsPerDayAvg: withAny.length ? round1(totalFeeds / withAny.length) : null,
    dataStatus: withAny.length === 0 ? "NO_DATA" : withAny.length < days.length ? "PARTIAL_DATA" : "RECORDED",
  };
}

/** Median interval between consecutive feeds on days with >= 2 records (minutes). */
export function calculateFeedingFrequency(feeds: FeedLike[]): { medianIntervalMin: number | null } {
  const byDay = new Map<string, number[]>();
  for (const f of feeds) {
    const arr = byDay.get(f.local_date) ?? [];
    arr.push(new Date(f.occurred_at).getTime());
    byDay.set(f.local_date, arr);
  }
  const gaps: number[] = [];
  for (const arr of byDay.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a - b);
    for (let i = 1; i < arr.length; i++) gaps.push((arr[i] - arr[i - 1]) / 60000);
  }
  if (!gaps.length) return { medianIntervalMin: null };
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return { medianIntervalMin: Math.round(med) };
}

export function formatMl(n: number) {
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ml`;
}

/** Weight change between two measurements. g/day only if >= 1 day apart. */
export function calculateWeightChange(a: { weight_kg: number; local_date: string }, b: { weight_kg: number; local_date: string }) {
  const deltaG = Math.round((b.weight_kg - a.weight_kg) * 1000);
  const days = Math.round((Date.parse(b.local_date) - Date.parse(a.local_date)) / 86_400_000);
  return { deltaG, days, gPerDay: days >= 1 ? Math.round((deltaG / days) * 10) / 10 : null };
}
