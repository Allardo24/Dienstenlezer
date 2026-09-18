import { describe, expect, it } from "vitest";
import type { Dienst, Movement } from "../types";
import { calculateDutyWage } from "./calculate";
import { DEFAULT_ORT_RATES, irregularHoursPercent } from "./rules";

const service: Dienst = {
  id: "service-1",
  serviceNumber: "V1",
  sourceFile: "test.pdf",
  pageNumber: 1,
  start: "06:00",
  end: "08:00",
};

function movement(overrides: Partial<Movement>): Movement {
  return {
    id: "movement-1",
    sourceFile: "test.pdf",
    pageNumber: 1,
    dienstnummer: "V1",
    vertrek: "06:00",
    aankomst: "08:00",
    van: "A",
    naar: "B",
    type: "rit",
    raw: "rit",
    ...overrides,
  };
}

describe("irregularHoursPercent", () => {
  it("past de grenzen op werkdagen toe", () => {
    expect(irregularHoursPercent(new Date(2026, 7, 10, 5, 29), false)).toBe(40);
    expect(irregularHoursPercent(new Date(2026, 7, 10, 5, 30), false)).toBe(30);
    expect(irregularHoursPercent(new Date(2026, 7, 10, 6, 0), false)).toBe(15);
    expect(irregularHoursPercent(new Date(2026, 7, 10, 7, 30), false)).toBe(0);
    expect(irregularHoursPercent(new Date(2026, 7, 10, 19, 0), false)).toBe(30);
  });

  it("past zaterdag, zondag en doorloop na zondag toe", () => {
    expect(irregularHoursPercent(new Date(2026, 7, 8, 12, 0), false)).toBe(30);
    expect(irregularHoursPercent(new Date(2026, 7, 9, 5, 29), false)).toBe(55);
    expect(irregularHoursPercent(new Date(2026, 7, 9, 5, 30), false)).toBe(45);
    expect(irregularHoursPercent(new Date(2026, 7, 10, 2, 0), true)).toBe(45);
  });

  it("gebruikt de centraal ingestelde percentages", () => {
    const rates = { ...DEFAULT_ORT_RATES, weekdayEarlyPercent: 22, sundayNightPercent: 61 };
    expect(irregularHoursPercent(new Date(2026, 7, 10, 6, 30), false, rates)).toBe(22);
    expect(irregularHoursPercent(new Date(2026, 7, 9, 3, 0), false, rates)).toBe(61);
  });
});

describe("calculateDutyWage", () => {
  it("betaalt alle dienstminuten en trekt alleen onbetaalde rust af", () => {
    const estimate = calculateDutyWage(
      service,
      [
        movement({}),
        movement({ id: "rest", vertrek: "07:00", aankomst: "07:15", van: "Onbetaalde rust", type: "pauze", raw: "Onbetaalde rust" }),
      ],
      "2026-08-10",
      new Date(2026, 7, 10, 7, 30),
      { hourlyRateCents: 1_200, holidayAllowancePercent: 8, vacationDaysAllowancePercent: 10.92 },
    );

    expect(estimate?.totalPaidMinutes).toBe(105);
    expect(estimate?.elapsedPaidMinutes).toBe(75);
    expect(estimate?.totalCents).toBe(2_325);
    expect(estimate?.earnedCents).toBe(1_725);
  });
});
