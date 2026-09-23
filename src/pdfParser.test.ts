import { describe, expect, it } from "vitest";
import { extractMaterialType, propagateMaterialByLoop } from "./materialType";
import { detectServiceNumber, detectServiceDepot } from "./pdfParser";
import type { Movement, TextItem } from "./types";

function text(text: string, x: number, y: number): TextItem {
  return { text, x, y, width: Math.max(10, text.length * 5) };
}

describe("stalling uit de dienstkop", () => {
  it.each([1, 1.7, 0.65])("leest gesplitste koptekst onafhankelijk van schaal (%s)", (scale) => {
    const items = [text("Dienst:", 40, 810), text("V1201", 130, 810),
      text("Lisse,", 270, 810), text("Garage", 307, 810), text("Qbuzz", 460, 810),
      text("Ma-Vr", 145, 790), text("03/08/2026", 280, 790),
      text("Start:", 40, 765), text("04:47", 100, 765),
      text("Lijn", 40, 745), text("Vertrek", 270, 745), text("Aankomst", 460, 745)];
    expect(detectServiceDepot(items.map((item) => ({ ...item, x: item.x * scale + 20, y: item.y * scale, width: item.width * scale }))))
      .toBe("Lisse, Garage");
  });

  it("accepteert onbekende namen en expliciete labels", () => {
    expect(detectServiceDepot([text("Standplaats: Nieuwedorp, Depot", 35, 810)]))
      .toBe("Nieuwedorp, Depot");
  });

  it("herkent de lange Groningse kop die links over het dienstnummervak uitsteekt", () => {
    expect(detectServiceDepot([
      { text: "V3001", x: 138, y: 799, width: 58 },
      { text: "Groningen, Garage Peizerweg [STREEK]", x: 192, y: 804, width: 270 },
      text("Dienst:", 48, 798), text("Ma-Vr", 148, 780), text("28/06/2026", 290, 780),
    ])).toBe("Groningen, Garage Peizerweg [STREEK]");
  });

  it("verzint geen stalling wanneer het kopvak ontbreekt", () => {
    expect(detectServiceDepot([text("Dienst:", 40, 810), text("CC1251", 130, 810),
      text("Qbuzz", 460, 810), text("30/08/2026", 280, 790)] )).toBeUndefined();
    expect(detectServiceDepot([])).toBeUndefined();
  });
});

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

describe("dienstnummer uit paginakop", () => {
  it.each(["P-7156/2", "L-7034", "CC1251", "ABCD-123456/A", "7156-2", "D12_B.3", "42"])("behoudt flexibel gelabeld nummer %s", (number) => {
    expect(detectServiceNumber([text("Dienst:", 48, 798), text(number, 129, 798), text("22/09/2026", 289, 780)])).toBe(number);
    expect(detectServiceNumber([text(`Dienst: ${number}`, 48, 798)])).toBe(number);
    expect(detectServiceNumber([text(`Dienstnummer ${number}`, 48, 798)])).toBe(number);
  });

  it("houdt stallingherkenning intact bij een gesplitste dienst", () => {
    expect(detectServiceDepot([text("Dienst:", 48, 798), text("P-7156/2", 129, 798),
      text("Katwijk, Garage", 272, 804), text("22/09/2026", 289, 780)])).toBe("Katwijk, Garage");
  });

  it("gebruikt geen datum of dienstverwijzing uit de ritregels", () => {
    expect(detectServiceNumber([text("Dienst:", 48, 798), text("22/09/2026", 129, 798),
      text("Lijn", 20, 737), text("Vertrek", 271, 737), text("Aankomst", 515, 737),
      text("Dienst: P-7156/2", 48, 660)])).toBe("pagina-1");
  });

  it("kiest het nummer naast Dienst en niet een viercijferige omloop in de tabel", () => {
    const items = [
      text("Dienst:", 28, 550),
      text("D1201", 105, 550),
      text("Ma-Vr", 190, 530),
      text("Lijn", 20, 485),
      text("Ritnr", 80, 485),
      text("Omloop", 140, 485),
      text("Vertrek", 205, 485),
      text("Aankomst", 510, 485),
      text("0001", 140, 450),
      text("0102", 140, 420),
    ];

    expect(detectServiceNumber(items)).toBe("D1201");
  });

  it("ondersteunt DMG-diensten met een dubbele letterprefix", () => {
    expect(detectServiceNumber([
      text("Dienst:", 48, 798),
      text("CC1251", 119, 798),
      text("Lijn", 50, 737),
      text("Vertrek", 271, 737),
      text("Aankomst", 515, 737),
      text("0001", 198, 660),
    ])).toBe("CC1251");
  });

  it("herkent een dienstnummer dat samen met het label in een tekstfragment staat", () => {
    expect(detectServiceNumber([
      text("Dienstnummer: 1201", 25, 560),
      text("Lijn", 20, 480),
      text("Vertrek", 205, 480),
      text("Aankomst", 510, 480),
      text("0001", 140, 440),
    ])).toBe("1201");
  });

  it("gebruikt zonder dienstlabel alleen een nummer uit de paginakop", () => {
    expect(detectServiceNumber([
      text("D1201", 105, 550),
      text("Lijn", 20, 485),
      text("Vertrek", 205, 485),
      text("Aankomst", 510, 485),
      text("0001", 140, 450),
    ])).toBe("D1201");
  });

  it("maakt zonder herkenbare paginakop geen dienst van een omloopnummer", () => {
    expect(detectServiceNumber([
      text("Lijn", 20, 485),
      text("Vertrek", 205, 485),
      text("Aankomst", 510, 485),
      text("0001", 140, 450),
    ], 7)).toBe("pagina-7");
  });
});
