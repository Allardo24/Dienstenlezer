import { describe, expect, it } from "vitest";
import { splitPersonalSchedules, suggestPersonalDivision } from "./personalSchedules";
import { detectServiceDepot, detectServiceNumber } from "./pdfParser";
import type { Dienst, ParseResult } from "./types";

const service: Dienst = { id: "a", sourceFile: "private.pdf", pageNumber: 1, serviceNumber: "L-7034", date: "18/09/2026", depot: "Katwijk, Garage" };

describe("persoonlijke diensten", () => {
  it("herkent een persoonlijk dienstnummer zonder de naam als stalling te lezen", () => {
    const items = [
      { text: "Dienst:", x: 48, y: 798, width: 44 },
      { text: "L-7034", x: 129, y: 798, width: 64 },
      { text: "Katwijk, Garage", x: 272, y: 804, width: 106 },
      { text: "18/09/2026", x: 289, y: 780, width: 70 },
      { text: "Naam Chauffeur", x: 75, y: 783, width: 84 },
    ];
    expect(detectServiceNumber(items)).toBe("L-7034");
    expect(detectServiceDepot(items)).toBe("Katwijk, Garage");
  });
  it("stelt alleen een eenduidige divisie met dezelfde stalling voor", () => {
    expect(suggestPersonalDivision(service, [{ ...service, divisionId: "lkn" }])).toBe("lkn");
    expect(suggestPersonalDivision(service, [{ ...service, divisionId: "lkn" }, { ...service, divisionId: "other" }])).toBe("");
    expect(suggestPersonalDivision(service, [])).toBe("");
  });
  it("weigert ontbrekende datums en lege diensten", () => {
    const result: ParseResult = { fileName: "test", diensten: [{ ...service, date: undefined }], movements: [], warnings: [] };
    expect(() => splitPersonalSchedules([result])).toThrow("uitvoeringsdatum");
    expect(() => splitPersonalSchedules([{ ...result, diensten: [service] }])).toThrow("Geen ritregels");
  });
  it("scheidt identieke dienstnummers op verschillende pagina's", () => {
    const movement = { id: "1", sourceFile: "test", pageNumber: 1, dienstnummer: service.serviceNumber, vertrek: "15:37", aankomst: "15:42", van: "Opstap", naar: "", type: "dienst" as const, raw: "" };
    const result: ParseResult = { fileName: "test", diensten: [service, { ...service, pageNumber: 2, date: "19/09/2026" }], movements: [movement, { ...movement, id: "2", pageNumber: 2 }], warnings: [] };
    const split = splitPersonalSchedules([result]);
    expect(split).toHaveLength(2);
    expect(split[0].movements.map((m) => m.id)).toEqual(["1"]);
    expect(split[1].movements.map((m) => m.id)).toEqual(["2"]);
  });
});
