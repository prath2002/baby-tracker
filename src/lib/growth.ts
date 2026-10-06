/**
 * WHO Child Growth Standards — LMS computations (spec §15).
 * No reference values live in code: L, M, S and SD columns come only from imported official WHO files.
 *
 * Method follows the WHO Anthro / igrowup convention as documented by WHO:
 *  - z = ((y/M)^L - 1) / (L*S)
 *  - For weight-based indicators (weight-for-age, weight-for-length/height, BMI-for-age) the
 *    "restricted" computation is applied beyond |z| > 3 using the distance between SD2 and SD3.
 *  - Length/height adjustments of ±0.7 cm when the measurement position does not match the age.
 * VERIFY against WHO Anthro outputs before release (spec Q9; dataset release gate).
 */
export type LMS = { l: number; m: number; s: number };
export type Indicator = "WFA" | "LHFA" | "WFL" | "WFH" | "BMI" | "HCFA";
export const RESTRICTED: Indicator[] = ["WFA", "WFL", "WFH", "BMI"];

export const valueAtZ = ({ l, m, s }: LMS, z: number) => (l === 0 ? m * Math.exp(s * z) : m * Math.pow(1 + l * s * z, 1 / l));

export function zScore(y: number, lms: LMS, indicator: Indicator): number {
  const { l, m, s } = lms;
  const z = l === 0 ? Math.log(y / m) / s : (Math.pow(y / m, l) - 1) / (l * s);
  if (!RESTRICTED.includes(indicator)) return z;
  if (z > 3) {
    const sd3 = valueAtZ(lms, 3), sd2 = valueAtZ(lms, 2);
    return 3 + (y - sd3) / (sd3 - sd2);
  }
  if (z < -3) {
    const sd3n = valueAtZ(lms, -3), sd2n = valueAtZ(lms, -2);
    return -3 + (y - sd3n) / (sd2n - sd3n);
  }
  return z;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf); accurate to ~1e-7. */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const a = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const erf = 1 - ((((a[4] * t + a[3]) * t + a[2]) * t + a[1]) * t + a[0]) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export const percentileFromZ = (z: number) => Math.round(normalCdf(z) * 1000) / 10;

/** Linear interpolation of LMS between two table rows (used for length/height axes in 0.1 cm steps). */
export function interpolateLms(x: number, rows: { x: number; l: number; m: number; s: number }[]): LMS | null {
  if (!rows.length) return null;
  const exact = rows.find((r) => Math.abs(r.x - x) < 1e-9);
  if (exact) return exact;
  const lo = [...rows].filter((r) => r.x < x).sort((a, b) => b.x - a.x)[0];
  const hi = [...rows].filter((r) => r.x > x).sort((a, b) => a.x - b.x)[0];
  if (!lo || !hi) return null;
  const t = (x - lo.x) / (hi.x - lo.x);
  return { l: lo.l + t * (hi.l - lo.l), m: lo.m + t * (hi.m - lo.m), s: lo.s + t * (hi.s - lo.s) };
}

/**
 * WHO convention: under 731 days use recumbent length; from 731 days standing height.
 * If position differs: standing under 2y -> +0.7 cm; recumbent from 2y -> -0.7 cm. (Verify vs WHO Anthro docs.)
 */
export function adjustLengthForPosition(cm: number, ageDays: number, position: "RECUMBENT" | "STANDING" | null) {
  if (!position) return { cm, adjusted: false };
  if (ageDays < 731 && position === "STANDING") return { cm: cm + 0.7, adjusted: true };
  if (ageDays >= 731 && position === "RECUMBENT") return { cm: cm - 0.7, adjusted: true };
  return { cm, adjusted: false };
}

/** Internal-consistency validation of an imported table: computed z of each published SD column must equal its label. */
export function validateSdColumns(rows: { l: number; m: number; s: number; sd: Record<string, number> | null }[], indicator: Indicator) {
  const labels: Record<string, number> = { SD3neg: -3, SD2neg: -2, SD1neg: -1, SD0: 0, SD1: 1, SD2: 2, SD3: 3 };
  let checked = 0, maxErr = 0;
  for (const r of rows) {
    if (!r.sd) continue;
    for (const [k, target] of Object.entries(labels)) {
      const v = r.sd[k];
      if (typeof v !== "number") continue;
      // published SD columns are rounded (typically to 0.1 kg / 0.1 cm), so compare in value space
      const expected = valueAtZ(r, target);
      const err = Math.abs(expected - v);
      maxErr = Math.max(maxErr, err);
      checked++;
    }
  }
  void indicator;
  return { checked, maxAbsValueError: Math.round(maxErr * 10000) / 10000, passed: checked > 0 && maxErr <= 0.051 };
}
