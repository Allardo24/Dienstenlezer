import { describe, expect, it } from "vitest";
import { hasInterveningDriver, type DutyVehicleInterval } from "./guidanceLogic";

const previous: DutyVehicleInterval = {
  loop: "806601",
  serviceNumber: "V6001",
  start: 8 * 60,
  end: 9 * 60,
};

const current: DutyVehicleInterval = {
  loop: "806601",
  serviceNumber: "V6001",
  start: 10 * 60,
  end: 11 * 60,
};

describe("hasInterveningDriver", () => {
  it("detecteert een andere chauffeur op dezelfde omloop tijdens de pauze", () => {
    expect(hasInterveningDriver(previous, current, [{
      loop: "806601",
      serviceNumber: "V6002",
      start: 9 * 60,
      end: 10 * 60,
    }])).toBe(true);
  });

  it("maakt geen overname van een gewone pauze zonder andere chauffeur", () => {
    expect(hasInterveningDriver(previous, current, [{
      loop: "806601",
      serviceNumber: "V6001",
      start: 9 * 60,
      end: 10 * 60,
    }])).toBe(false);
  });

  it("negeert activiteit op een andere omloop of buiten de pauze", () => {
    expect(hasInterveningDriver(previous, current, [
      { loop: "806602", serviceNumber: "V6002", start: 9 * 60, end: 10 * 60 },
      { loop: "806601", serviceNumber: "V6003", start: 7 * 60, end: 8 * 60 },
    ])).toBe(false);
  });
});
