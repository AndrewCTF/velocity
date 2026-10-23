import { describe, expect, it } from "vitest";
import { baselineOf, dailyContacts, underwayDaysByMonth } from "./archive.js";

describe("archive series", () => {
  it("counts underway days per month and leaves unarchived months empty", () => {
    const t = (iso: string) => Date.parse(iso) / 1000;
    const r = underwayDaysByMonth(
      [
        { t: t("2026-10-01T01:00:00Z"), sog: 5 },
        { t: t("2026-10-01T09:00:00Z"), sog: 7 },
        { t: t("2026-10-02T01:00:00Z"), sog: 0 },
        { t: t("2026-10-03T01:00:00Z"), sog: 1.2 },
        { t: t("2026-09-15T01:00:00Z"), sog: 0 },
      ],
      Date.parse("2026-10-23T00:00:00Z"),
      3,
    );
    expect(r).toEqual([
      { label: "Aug", days: null },
      { label: "Sep", days: 0 },
      { label: "Oct", days: 2 },
    ]);
  });

  it("counts distinct contacts per day inside the radius", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const d = (iso: string) => Date.parse(iso) / 1000;
    const r = dailyContacts(
      [
        {
          id: "a",
          points: [
            [56, 27.01, d("2026-10-23T01:00:00Z"), 0],
            [56, 27.01, d("2026-10-23T05:00:00Z"), 0],
          ],
        },
        { id: "b", points: [[56, 27.02, d("2026-10-23T02:00:00Z"), 0]] },
        { id: "c", points: [[57, 28, d("2026-10-22T02:00:00Z"), 0]] },
      ],
      27,
      56,
      14,
      now,
      3,
    );
    expect(r).toEqual([
      { day: "2026-10-21", n: null },
      { day: "2026-10-22", n: 0 },
      { day: "2026-10-23", n: 2 },
    ]);
    expect(baselineOf([null, 4, 2, 9])).toBe(3);
    expect(baselineOf([9])).toBeNull();
  });
});
