import { describe, expect, it } from "vitest";
import {
  calculateTakeoverStatus,
  resolveTakeoverArrivalMinute,
  resolveTakeoverDeparted,
  resolveTakeoverPlannedMinute,
} from "./takeoverStatus";

const base = {
  currentMinute: 14 * 60,
  plannedDepartureMinute: 14 * 60 + 11,
  expectedArrivalMinute: 14 * 60 + 6,
  delaySeconds: 120,
  hasLiveData: true,
  arrived: false,
  departed: false,
};

describe("overnamestatus", () => {
  it("toont een risicovolle vertraging bovenaan binnen tien minuten", () => {
    const status = calculateTakeoverStatus({ ...base, currentMinute: 14 * 60 + 2 });
    expect(status.tone).toBe("late");
    expect(status.minutesToDeparture).toBe(5);
    expect(status.shouldShowTopAlert).toBe(true);
  });

  it("noemt een vertraagde bus met ruime overstap niet op tijd", () => {
    const status = calculateTakeoverStatus({ ...base, plannedDepartureMinute: 14 * 60 + 20 });
    expect(status.tone).toBe("roomy");
    expect(status.statusLabel).toBe("Vertraagd, voldoende tijd");
    expect(status.shouldShowTopAlert).toBe(false);
  });

  it("houdt de bovenste melding weg tot tien minuten voor vertrek", () => {
    const status = calculateTakeoverStatus({ ...base, currentMinute: 13 * 60 + 55 });
    expect(status.shouldShowTopAlert).toBe(false);
  });

  it("laat zonder livegegevens geen punctualiteitsoordeel zien", () => {
    const status = calculateTakeoverStatus({ ...base, hasLiveData: false });
    expect(status.phase).toBe("no-data");
    expect(status.statusLabel).toBe("");
  });

  it("verbergt de bovenste melding zodra de bus vertrokken is", () => {
    const status = calculateTakeoverStatus({ ...base, arrived: true, departed: true });
    expect(status.phase).toBe("departed");
    expect(status.shouldShowTopAlert).toBe(false);
  });

  it("wisselt bij stilstand op de overnamehalte naar aangekomen", () => {
    const status = calculateTakeoverStatus({ ...base, currentMinute: 14 * 60 + 1, arrived: true });
    expect(status.phase).toBe("arrived");
    expect(status.statusLabel).toBe("Aangekomen");
    expect(status.shouldShowTopAlert).toBe(true);
  });
});

describe("verwachte overname-aankomst", () => {
  it("weigert een voorspelling die uren van de geplande aankomst afwijkt", () => {
    expect(resolveTakeoverArrivalMinute({
      plannedArrivalMinute: 19 * 60 + 30,
      delaySeconds: 3 * 60,
      predictedArrivalMinute: 60,
    })).toBe(19 * 60 + 33);
  });

  it("accepteert een kloppende voorspelling over middernacht", () => {
    expect(resolveTakeoverArrivalMinute({
      plannedArrivalMinute: 23 * 60 + 58,
      delaySeconds: 5 * 60,
      predictedArrivalMinute: 3,
    })).toBe(24 * 60 + 3);
  });

  it("leidt de geplande aankomst af als het pdf-tijdstip niet bij de live vertraging past", () => {
    expect(resolveTakeoverPlannedMinute({
      suppliedPlannedMinute: 19 * 60 + 33,
      expectedArrivalMinute: 19 * 60 + 30,
      delaySeconds: 2 * 60,
    })).toBe(19 * 60 + 28);
  });
});

describe("afronden van een overname", () => {
  it("negeert een te vroege halte-gepasseerdmelding zolang de bus nog wordt verwacht", () => {
    expect(resolveTakeoverDeparted({
      currentMinute: 11 * 60 + 6,
      plannedDepartureMinute: 11 * 60 + 9,
      expectedArrivalMinute: 11 * 60 + 11,
      expectedDepartureMinute: 11 * 60 + 11,
      reportedDeparted: true,
    })).toBe(false);
  });

  it("rondt af zodra een inmiddels mogelijke passage expliciet is gemeld", () => {
    expect(resolveTakeoverDeparted({
      currentMinute: 11 * 60 + 12,
      plannedDepartureMinute: 11 * 60 + 9,
      expectedArrivalMinute: 11 * 60 + 11,
      expectedDepartureMinute: 11 * 60 + 11,
      reportedDeparted: true,
    })).toBe(true);
  });

  it("leidt vertrek zonder voertuigmelding pas af nadat alle relevante tijden voorbij zijn", () => {
    expect(resolveTakeoverDeparted({
      currentMinute: 11 * 60 + 10,
      plannedDepartureMinute: 11 * 60 + 9,
      expectedArrivalMinute: 11 * 60 + 11,
      expectedDepartureMinute: 11 * 60 + 8,
      reportedDeparted: false,
    })).toBe(false);
    expect(resolveTakeoverDeparted({
      currentMinute: 11 * 60 + 12,
      plannedDepartureMinute: 11 * 60 + 9,
      expectedArrivalMinute: 11 * 60 + 11,
      expectedDepartureMinute: 11 * 60 + 8,
      reportedDeparted: false,
    })).toBe(true);
  });
});
