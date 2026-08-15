import { describe, expect, it } from "vitest";
import { extractMaterialType, propagateMaterialByLoop } from "./materialType";
import type { Movement } from "./types";

function movement(overrides: Partial<Movement>): Movement {
  return {
    id: "movement",
    sourceFile: "test.pdf",
    pageNumber: 1,
    dienstnummer: "V1",
    datum: "2026-08-09",
    omloopnummer: "806601",
    lijnnummer: "20",
    ritnummer: "1",
    vertrek: "10:00",
    aankomst: "10:10",
    van: "A",
    naar: "B",
    type: "rit",
    raw: "",
    ...overrides,
  };
}

describe("materieelsoort uit dienstblad", () => {
  it("haalt de relevante tekst uit beschrijvende regels", () => {
    expect(extractMaterialType("Meenemen Yutong 13m Snelbuzz")).toBe("Yutong 13m Snelbuzz");
    expect(extractMaterialType("Elektrische bus 18m VDL - Qlk Groen voor dienst 3107")).toBe(
      "Elektrische bus 18m VDL - Qlk Groen",
    );
    expect(extractMaterialType("Meenemen Volvo 12m Stad")).toBe("Volvo 12m Stad");
    expect(extractMaterialType("Iveco 12 mtr Stad voor dienst 6001")).toBe("Iveco 12 mtr Stad");
    expect(extractMaterialType("Meenemen Mercedes-Benz eCitaro 18m")).toBe("Mercedes-Benz eCitaro 18m");
    expect(extractMaterialType("BYD K11U 13m voor dienst 6201")).toBe("BYD K11U 13m");
    expect(extractMaterialType("Nieuw nog onbekend bustype van dienst G6202")).toBe("Nieuw nog onbekend bustype");
    expect(extractMaterialType("Capacity paars voor dienst 3044")).toBe("Capacity paars");
    expect(extractMaterialType("Q-liner 14 meter Dubbeldekker van Hool van dienst 3405")).toBe(
      "Q-liner 14 meter Dubbeldekker van Hool",
    );
    expect(extractMaterialType("Meenemen Aflosauto")).toBeUndefined();
    expect(extractMaterialType("Aflosauto van dienst 1308")).toBeUndefined();
    expect(extractMaterialType("Aflosauto voor dienst 3211")).toBeUndefined();
    expect(extractMaterialType("Bus parkeren op 1J")).toBeUndefined();
    expect(extractMaterialType("Bus aan lader")).toBeUndefined();
    expect(extractMaterialType("Bus naar lader 1F")).toBeUndefined();
    expect(extractMaterialType("Bus van 1H")).toBeUndefined();
    expect(extractMaterialType("Bus staat voor pantograaf 3B")).toBeUndefined();
    expect(extractMaterialType("Netto Pauze")).toBeUndefined();
  });

  it("neemt de omschrijving alleen mee zolang dezelfde busomloop actief blijft", () => {
    const first = movement({ id: "first", materieelsoort: "Yutong 13m Snelbuzz" });
    const inherited = movement({ id: "inherited", vertrek: "10:12", aankomst: "10:25" });
    const returned = movement({
      id: "returned",
      vertrek: "10:25",
      aankomst: "10:26",
      type: "materiaal",
      raw: "Bus aan lader",
    });
    const afterReturn = movement({ id: "after-return", vertrek: "10:30", aankomst: "10:45" });
    const otherLoop = movement({ id: "other-loop", omloopnummer: "806602", vertrek: "10:05", aankomst: "10:15" });

    propagateMaterialByLoop([first, inherited, returned, afterReturn, otherLoop]);

    expect(inherited.materieelsoort).toBe("Yutong 13m Snelbuzz");
    expect(otherLoop.materieelsoort).toBeUndefined();
    expect(afterReturn.materieelsoort).toBeUndefined();
  });
});
