import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANIZATION,
  normalizeOrganization,
  organizationItemId,
  scheduleSelectionKey,
} from "./organization";

describe("organization", () => {
  it("migreert een ontbrekende indeling naar een lege organisatie", () => {
    expect(normalizeOrganization()).toEqual(DEFAULT_ORGANIZATION);
  });

  it("verwijdert de oude ingebouwde Standaard-groep", () => {
    expect(normalizeOrganization({
      concessions: [{ id: "standaard", name: "Standaard" }],
      divisions: [{ id: "standaard", name: "Standaard", concessionId: "standaard" }],
    })).toEqual(DEFAULT_ORGANIZATION);
  });

  it("maakt stabiele unieke ids voor nieuwe groepen", () => {
    expect(organizationItemId("Zuid-Holland Noord", [])).toBe("zuid-holland-noord");
    expect(organizationItemId("Zuid-Holland Noord", ["zuid-holland-noord"])).toBe("zuid-holland-noord-2");
  });

  it("maakt dezelfde roostersleutel ongeacht aanvinkvolgorde", () => {
    expect(scheduleSelectionKey("weekday", ["gd", "zh-n"])).toBe(
      scheduleSelectionKey("weekday", ["zh-n", "gd"]),
    );
  });
});
