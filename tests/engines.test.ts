import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { calculateDailyMeasuredMilk, calculateRangeMeasuredMilk, calculateFeedingFrequency, ozToMl, calculateWeightChange } from "@/lib/milk";
import { zScore, valueAtZ, percentileFromZ, interpolateLms, adjustLengthForPosition, validateSdColumns, normalCdf } from "@/lib/growth";
import { resolveReference, derivePopulations, clinicalRuleApplies, type RuleRow, type BabyFacts } from "@/server/reference/engine";
import { buildPlan, ageToDate } from "@/server/vaccines";
import { sniffMime, pdfActiveContent } from "@/server/files";
import { toCsv, zipStore } from "@/server/zip";

const feed = (t: string, ml: number | null, date = "2026-10-06", h = 8) => ({ feeding_type: t as any, quantity_ml: ml, local_date: date, occurred_at: `${date}T${String(h).padStart(2, "0")}:00:00+05:30` });

describe("milk math (spec §20)", () => {
  it("brief example 13: 90+100+120+100 = 410 with BF not converted", () => {
    const d = calculateDailyMeasuredMilk([feed("EXPRESSED_BREASTMILK", 90, undefined, 8), feed("EXPRESSED_BREASTMILK", 100, undefined, 11), feed("EXPRESSED_BREASTMILK", 120, undefined, 14), feed("EXPRESSED_BREASTMILK", 100, undefined, 17), feed("DIRECT_BREASTFEEDING", null, undefined, 9)], "2026-10-06");
    expect(d.measuredMl).toBe(410);
    expect(d.messages).toEqual(["410 ml measurable milk recorded.", "Additional direct breastfeeding sessions were recorded but not converted to volume."]);
  });
  it("brief example 12: 8 BF sessions => measured NOT_AVAILABLE", () => {
    const d = calculateDailyMeasuredMilk(Array.from({ length: 8 }, (_, i) => feed("DIRECT_BREASTFEEDING", null, undefined, i + 1)), "2026-10-06");
    expect(d.measuredMl).toBeNull();
    expect(d.directBreastfeedingSessions).toBe(8);
    expect(d.messages).toContain("Direct breastfeeding volume cannot be reliably measured from duration alone.");
  });
  it("OTHER is excluded from milk totals", () => {
    expect(calculateDailyMeasuredMilk([feed("OTHER", null), feed("FORMULA", 60)], "2026-10-06").measuredMl).toBe(60);
  });
  it("mixed feeding totals by type", () => {
    const d = calculateDailyMeasuredMilk([feed("EXPRESSED_BREASTMILK", 200), feed("FORMULA", 150), feed("DIRECT_BREASTFEEDING", null)], "2026-10-06");
    expect(d.measuredMl).toBe(350);
    expect(d.measuredMlByType).toEqual({ EXPRESSED_BREASTMILK: 200, FORMULA: 150 });
  });
  it("NO_DATA vs RECORDED; averages over days with data only (denominator)", () => {
    const r = calculateRangeMeasuredMilk([feed("FORMULA", 100, "2026-10-01"), feed("FORMULA", 300, "2026-10-03"), feed("DIRECT_BREASTFEEDING", null, "2026-10-04")], ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(r.days.map((d) => d.dataStatus)).toEqual(["RECORDED", "NO_DATA", "RECORDED", "RECORDED"]);
    expect(r.daysWithMeasuredData).toBe(2);
    expect(r.avgMeasuredMlPerDayWithData).toBe(200);
    expect(r.dataStatus).toBe("PARTIAL_DATA");
  });
  it("oz conversion uses 29.5735", () => { expect(ozToMl(3)).toBe(88.7); expect(ozToMl(1)).toBe(29.6); });
  it("median interval", () => { expect(calculateFeedingFrequency([feed("FORMULA", 1, undefined, 1), feed("FORMULA", 1, undefined, 4), feed("FORMULA", 1, undefined, 6)]).medianIntervalMin).toBe(150); });
  it("weight change g/day only when ≥ 1 day apart", () => {
    expect(calculateWeightChange({ weight_kg: 4.5, local_date: "2026-09-01" }, { weight_kg: 4.8, local_date: "2026-09-11" })).toEqual({ deltaG: 300, days: 10, gPerDay: 30 });
    expect(calculateWeightChange({ weight_kg: 4.5, local_date: "2026-09-01" }, { weight_kg: 4.6, local_date: "2026-09-01" }).gPerDay).toBeNull();
  });
});

describe("growth LMS method (no reference values embedded — synthetic LMS only)", () => {
  const lms = { l: 0.35, m: 5.0, s: 0.12 }; // synthetic test parameters, not WHO values
  it("z of M is 0 and value↔z round-trips", () => {
    expect(zScore(5.0, lms, "LHFA")).toBeCloseTo(0, 10);
    for (const z of [-2.5, -1, 0.7, 2.2]) expect(zScore(valueAtZ(lms, z), lms, "WFA")).toBeCloseTo(z, 8);
  });
  it("restricted computation beyond ±3 SD for weight-based indicators only", () => {
    const sd3 = valueAtZ(lms, 3), sd2 = valueAtZ(lms, 2), y = sd3 + (sd3 - sd2) * 0.5;
    expect(zScore(y, lms, "WFA")).toBeCloseTo(3.5, 8);
    expect(zScore(y, lms, "LHFA")).not.toBeCloseTo(3.5, 3);
  });
  it("L = 0 uses log form", () => { expect(zScore(Math.exp(0.1 * 2) * 3, { l: 0, m: 3, s: 0.1 }, "HCFA")).toBeCloseTo(2, 10); });
  it("percentiles from z", () => { expect(percentileFromZ(0)).toBe(50); expect(percentileFromZ(-1.8808)).toBe(3); expect(percentileFromZ(1.8808)).toBe(97); expect(normalCdf(1.96)).toBeCloseTo(0.975, 3); });
  it("interpolates LMS between table rows; null outside range", () => {
    const rows = [{ x: 50, l: 1, m: 3, s: 0.1 }, { x: 50.1, l: 1, m: 3.1, s: 0.1 }];
    expect(interpolateLms(50.05, rows)!.m).toBeCloseTo(3.05, 10);
    expect(interpolateLms(60, rows)).toBeNull();
  });
  it("length/height position adjustment", () => {
    expect(adjustLengthForPosition(80, 600, "STANDING")).toEqual({ cm: 80.7, adjusted: true });
    expect(adjustLengthForPosition(90, 800, "RECUMBENT")).toEqual({ cm: 89.3, adjusted: true });
    expect(adjustLengthForPosition(80, 600, "RECUMBENT").adjusted).toBe(false);
  });
  it("dataset validation detects SD columns that don't match L,M,S", () => {
    const good = [{ ...lms, sd: { SD2neg: +valueAtZ(lms, -2).toFixed(4), SD0: 5, SD2: +valueAtZ(lms, 2).toFixed(4) } }];
    expect(validateSdColumns(good, "WFA").passed).toBe(true);
    expect(validateSdColumns([{ ...lms, sd: { SD2: 9.9 } }], "WFA").passed).toBe(false);
  });
});

describe("reference engine gating (spec §20.3)", () => {
  const facts = (o: Partial<BabyFacts> = {}): BabyFacts => ({ ageDays: 2, dayOfLife: 3, birthWeightKg: 1.4, latestWeightKg: 1.4, gaWeeks: 31, gaUnknown: false, unableToBreastfeed: null, showClinicalReferences: true, ...o });
  const rule = (id: string, gate: string, payload: Record<string, unknown> = {}): RuleRow => ({ id, bucket: id.startsWith("CFR") ? "clinical_feeding_rules" : "feeding_guidelines", source_id: "SRC_NHM_KMC_LBW", population: "LOW_BIRTH_WEIGHT", clinical_context: "NEONATAL_FLUID_MANAGEMENT", release_gate: gate, payload: { provenance: { source_id: "X" }, ...payload } });
  const d3 = rule("CFR_NHM_FLUID_D3_LT_1500G", "CLEARED", { birth_weight_min_kg: null, birth_weight_max_kg_exclusive: 1.5, day_of_life_min: 3, day_of_life_max: 3, value_target: 110, unit: "ml/kg/day", warnings: [] });
  it("populations from WHO definitions; unknown stays null", () => {
    expect(derivePopulations({ birthWeightKg: 2.6, gaWeeks: null, gaUnknown: true })).toMatchObject({ lbw: false, preterm: null });
    expect(derivePopulations({ birthWeightKg: 2.49, gaWeeks: 36, gaUnknown: false })).toMatchObject({ lbw: true, preterm: true, vlbw: false });
  });
  it("NHM day/band matching", () => {
    expect(clinicalRuleApplies(d3, facts())).toBe(true);
    expect(clinicalRuleApplies(d3, facts({ dayOfLife: 4 }))).toBe(false);
    expect(clinicalRuleApplies(d3, facts({ birthWeightKg: 1.6 }))).toBe(false);
    expect(clinicalRuleApplies(d3, facts({ birthWeightKg: null }))).toBe(false);
  });
  it("blocked rule never displays; LBW gets NOT_ESTABLISHED", () => {
    const r = resolveReference([{ ...d3, release_gate: "BLOCKED_UNTIL_PRIMARY_SOURCE_VERIFIED" }], facts(), "ANY", null);
    expect(r.reference_status).toBe("NOT_ESTABLISHED");
    expect(r.rules).toEqual([]);
  });
  it("cleared rule displays as Clinical reference with care-team warning, no per-baby ml", () => {
    const r = resolveReference([d3], facts(), "ANY", null);
    expect(r.reference_status).toBe("CLINICAL_REFERENCE");
    expect(r.rules[0]).toMatchObject({ label: "Clinical reference", value_target: 110, unit: "ml/kg/day" });
    expect(JSON.stringify(r)).not.toContain("154"); // 110 × 1.4 kg must never be computed
  });
  it("hidden when parent hasn't enabled clinical references", () => {
    expect(resolveReference([d3], facts({ showClinicalReferences: false }), "ANY", null).rules).toEqual([]);
  });
  it("healthy term => NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND", () => {
    const r = resolveReference([d3], facts({ birthWeightKg: 3.2, gaWeeks: 40, dayOfLife: 3 }), "DIRECT_BREASTFEEDING", null);
    expect(r.reference_status).toBe("NO_AUTHORITATIVE_UNIVERSAL_VALUE_FOUND");
  });
  it("two issuers => CONFLICT_REQUIRES_REVIEW, both shown", () => {
    const other = { ...d3, id: "CFR_WHO_HEPNFS_LT2500_START", source_id: "SRC_WHO_HEP_NFS_21_41", payload: { ...d3.payload, value_target: 60 } };
    const r = resolveReference([d3, other], facts({ unableToBreastfeed: true }), "ANY", null);
    expect(r.reference_status).toBe("CONFLICT_REQUIRES_REVIEW");
    expect(r.rules).toHaveLength(2);
  });
});

describe("vaccine plan (versioned, no invented overdue thresholds)", () => {
  const items = new Map([["UIP_BCG", { release_gate: "CLEARED", provenance: {} }], ["UIP_FIPV3", { release_gate: "CLEARED", provenance: {} }], ["UIP_OPV0", { release_gate: "CLEARED", provenance: {} }], ["UIP_JE1", { release_gate: "CLEARED", provenance: {} }]]);
  it("calendar-month due dates clamp", () => { expect(ageToDate("2026-01-31", { months: 1 })).toBe("2026-02-28"); expect(ageToDate("2026-01-01", { days: 42 })).toBe("2026-02-12"); });
  it("fIPV-3 only for doses due from 2023-01-01", () => {
    expect(buildPlan({ scheduleId: "GOVERNMENT_OF_INDIA_UIP", birthDate: "2021-01-01", today: "2026-10-06", jeOptIn: false, given: [], items }).items.find((i) => i.code === "FIPV_3")).toBeUndefined();
    expect(buildPlan({ scheduleId: "GOVERNMENT_OF_INDIA_UIP", birthDate: "2026-06-01", today: "2026-10-06", jeOptIn: false, given: [], items }).items.find((i) => i.code === "FIPV_3")).toBeTruthy();
  });
  it("past stated max age => PAST_STATED_AGE_LIMIT (ask your vaccinator), never 'overdue' invented", () => {
    const p = buildPlan({ scheduleId: "GOVERNMENT_OF_INDIA_UIP", birthDate: "2026-09-01", today: "2026-10-06", jeOptIn: false, given: [], items });
    expect(p.items.find((i) => i.code === "OPV_0")!.status).toBe("PAST_STATED_AGE_LIMIT");
    expect(p.items.find((i) => i.code === "BCG")!.status).toBe("DUE");
  });
  it("unreleased items are withheld and counted", () => {
    const p = buildPlan({ scheduleId: "GOVERNMENT_OF_INDIA_UIP", birthDate: "2026-06-01", today: "2026-10-06", jeOptIn: false, given: [], items });
    expect(p.pendingReview).toBeGreaterThan(10);
  });
  it("JE is not applicable unless opted in", () => {
    const p = buildPlan({ scheduleId: "GOVERNMENT_OF_INDIA_UIP", birthDate: "2025-06-01", today: "2026-10-06", jeOptIn: false, given: [], items });
    expect(p.items.find((i) => i.code === "JE_1")!.status).toBe("NOT_APPLICABLE");
  });
});

describe("files & export helpers", () => {
  it("magic-byte sniffing", () => {
    expect(sniffMime(Buffer.from("%PDF-1.7"))).toBe("application/pdf");
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMime(Buffer.from("GIF89a"))).toBeNull();
    expect(sniffMime(Buffer.from("<html><script>"))).toBeNull();
  });
  it("PDF active content detection", () => {
    expect(pdfActiveContent(Buffer.from("%PDF /OpenAction << /S /JavaScript /JS (x) >>"))).toBe("embedded JavaScript");
    expect(pdfActiveContent(Buffer.from("%PDF /Type /Page"))).toBeNull();
  });
  it("CSV guards against formula injection", () => { expect(toCsv([{ a: "=HYPERLINK(1)", b: 'x,"y"' }])).toBe(`a,b\n'=HYPERLINK(1),"x,""y"""\n`); });
  it("zip has valid signatures", () => {
    const z = zipStore([{ name: "a.txt", data: Buffer.from("hello") }]);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
  });
});

describe("clinical copy lint (spec §5, §38)", () => {
  const FORBIDDEN = /\b(required milk|should drink|underfed|overfed|your baby is (healthy|unhealthy|normal|abnormal))\b/i;
  const ALLOWED_FILES = ["reference/medical_reference_data.json"];
  function* walk(dir: string): Generator<string> {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) yield* walk(p);
      else if (/\.(tsx?|json|html)$/.test(f)) yield p;
    }
  }
  it("no forbidden phrases in user-facing source", () => {
    const hits: string[] = [];
    for (const f of walk("src")) {
      const text = readFileSync(f, "utf8");
      text.split("\n").forEach((line, i) => {
        if (FORBIDDEN.test(line) && !/forbidden|never|not\.toMatch|Forbidden|forbidden_labels/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(ALLOWED_FILES.length).toBe(1);
    expect(hits).toEqual([]);
  });
  it("no hard-coded clinical reference numbers in source (they live in the reviewed data file)", () => {
    const suspicious: string[] = [];
    for (const f of walk("src")) {
      const t = readFileSync(f, "utf8");
      if (/ml\/kg\/day[^"'`]*\b(60|75|80|90|95|105|110|120|125|135|140|150|180|200)\b/.test(t)) suspicious.push(f);
    }
    expect(suspicious).toEqual([]);
  });
});
