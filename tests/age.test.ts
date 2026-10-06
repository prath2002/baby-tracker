import { describe, it, expect } from "vitest";
import { calculateBabyAge, AgeError, localDateOf } from "@/lib/age";

const at = (d: string) => new Date(`${d}T12:00:00+05:30`);
const TZ = "Asia/Kolkata";
describe("age (spec §21 vectors)", () => {
  const V: [string, string, number, number, number, number, number][] = [
    ["2026-06-30", "2026-10-06", 98, 14, 0, 3, 6],
    ["2026-06-27", "2026-10-06", 101, 14, 3, 3, 9],
    ["2024-02-29", "2025-02-28", 365, 52, 1, 12, 0],
    ["2024-02-29", "2025-03-01", 366, 52, 2, 12, 1],
    ["2026-01-31", "2026-02-28", 28, 4, 0, 1, 0],
    ["2026-01-31", "2026-03-01", 29, 4, 1, 1, 1],
    ["2026-10-06", "2026-10-06", 0, 0, 0, 0, 0],
  ];
  for (const [b, t, days, w, r, m, md] of V) {
    it(`${b} -> ${t}`, () => {
      const a = calculateBabyAge({ birthDate: b }, at(t), TZ);
      expect([a.totalDays, a.completedWeeks, a.remainingDays, a.completedMonths, a.monthRemainderDays]).toEqual([days, w, r, m, md]);
    });
  }
  it("display 14 weeks 3 days", () => {
    expect(calculateBabyAge({ birthDate: "2026-06-27" }, at("2026-10-06"), TZ).display).toBe("14 weeks 3 days");
  });
  it("rejects future and impossible dates", () => {
    expect(() => calculateBabyAge({ birthDate: "2026-10-07" }, at("2026-10-06"), TZ)).toThrow(AgeError);
    expect(() => calculateBabyAge({ birthDate: "2025-02-29" }, at("2026-10-06"), TZ)).toThrow(AgeError);
    expect(() => calculateBabyAge({ birthDate: "2026-13-01" }, at("2026-10-06"), TZ)).toThrow(AgeError);
  });
  it("future birth time today rejected", () => {
    expect(() => calculateBabyAge({ birthDate: "2026-10-06", birthTime: "23:00" }, new Date("2026-10-06T12:00:00+05:30"), TZ)).toThrow(AgeError);
  });
  it("IST midnight boundary: 00:30 IST is the next local date vs UTC", () => {
    expect(localDateOf(new Date("2026-02-28T19:00:00Z"), TZ)).toBe("2026-03-01");
  });
  it("device timezone change does not change age (household tz drives it)", () => {
    const now = new Date("2026-10-06T20:00:00Z"); // 01:30 IST on 7 Oct, 16:00 New York on 6 Oct
    expect(calculateBabyAge({ birthDate: "2026-10-01" }, now, TZ).totalDays).toBe(6);
  });
});
