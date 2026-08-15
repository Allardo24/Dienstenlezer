import { describe, expect, it } from "vitest";
import { assertUsableReparseResult } from "./storage";

describe("assertUsableReparseResult", () => {
  it("accepteert een parse-resultaat met diensten en ritregels", () => {
    expect(() => assertUsableReparseResult("dienst.pdf", {
      fileName: "dienst.pdf",
      diensten: [{
        id: "d1",
        serviceNumber: "V1001",
        sourceFile: "dienst.pdf",
        pageNumber: 1,
      }],
      movements: [{
        id: "m1",
        sourceFile: "dienst.pdf",
        pageNumber: 1,
        dienstnummer: "V1001",
        vertrek: "08:00",
        aankomst: "08:30",
        van: "A",
        naar: "B",
        type: "rit",
        raw: "4 1001 806601 08:00 A B 08:30",
      }],
      warnings: [],
    })).not.toThrow();
  });

  it("weigert een leeg resultaat en bewaart de parserwaarschuwing", () => {
    expect(() => assertUsableReparseResult("dienst.pdf", {
      fileName: "dienst.pdf",
      diensten: [],
      movements: [],
      warnings: ["dienst.pdf: kon pdf niet uitlezen (Promise.try ontbreekt)."],
    })).toThrow(/bestaande gegevens zijn niet vervangen.*Promise\.try ontbreekt/);
  });
});
