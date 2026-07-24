import { describe, expect, it } from "vitest";
import {
  detectMovementColumnLayout,
  isBuslessDriverRow,
  textInMovementColumn,
  withoutLegacyOvChipNumber,
  type TextRow,
} from "./pdfColumns";

function item(text: string, center: number, width = 30) {
  return { text, x: center - width / 2, y: 700, width };
}

describe("detectMovementColumnLayout", () => {
  it("houdt voor bestaande dienstbladen de vaste kolommen aan", () => {
    const header: TextRow = {
      items: [
        item("Lijn", 45), item("Ritnr", 145), item("Omloop", 215),
        item("Vertrek", 280), item("Van", 365), item("Naar", 465), item("Aankomst", 540),
      ],
    };

    expect(detectMovementColumnLayout([header]).useItemCenters).toBe(false);
  });

  it("slaat de extra OV-chipkolom over", () => {
    const header: TextRow = {
      items: [
        item("Lijn", 45), item("OV-chip", 115), item("Ritnr", 195), item("Omloop", 280),
        item("Vertrek", 370), item("Van", 455), item("Naar", 555), item("Aankomst", 660),
      ],
    };
    const row: TextRow = {
      items: [
        item("1", 45), item("273", 115), item("9016", 195), item("64 6021", 280),
        item("10:03", 370), item("GnCS A6", 455), item("P+R Rdp", 555), item("10:29", 660),
      ],
    };
    const layout = detectMovementColumnLayout([header]);
    const read = (key: keyof typeof layout.ranges) => textInMovementColumn(row, layout.ranges[key], layout.useItemCenters);

    expect(read("line")).toBe("1");
    expect(read("trip")).toBe("9016");
    expect(read("loop")).toBe("64 6021");
    expect(read("departure")).toBe("10:03");
    expect(read("arrival")).toBe("10:29");
  });
});

describe("isBuslessDriverRow", () => {
  it("herkent busloze chauffeursacties", () => {
    expect(isBuslessDriverRow("REIS 09:54 GnCS A GnCS A 09:57")).toBe(true);
    expect(isBuslessDriverRow("3 Rij mee 09:49 GnBdrPzw GnCS A 09:54")).toBe(true);
    expect(isBuslessDriverRow("19:42 Prep-in 19:43")).toBe(true);
    expect(isBuslessDriverRow("20:10 Rijklaarmaken 20:13")).toBe(true);
    expect(isBuslessDriverRow("1 273 9016 64 6021 10:03 GnCS A6 P+R Rdp 10:29")).toBe(false);
  });

  it("herkent een zelf toegevoegde actie", () => {
    expect(isBuslessDriverRow("12:00 Controle bus 12:03", ["Controle bus"])).toBe(true);
    expect(isBuslessDriverRow("12:00 Controle bus 12:03", ["REIS"])).toBe(false);
  });
});

describe("withoutLegacyOvChipNumber", () => {
  it("verwijdert een oud meegeslagen OV-chipnummer", () => {
    expect(withoutLegacyOvChipNumber("63 53", "8006", "63 53 8006 44 6402 07:07 GnCS B2 LwoHaven 08:20")).toBe("63");
    expect(withoutLegacyOvChipNumber("178 665", "8035", "178 665 8035 13:41 SdbLwrht GnCS 14:30")).toBe("178");
  });

  it("laat normale lijnnummers ongemoeid", () => {
    expect(withoutLegacyOvChipNumber("401", "7053", "401 7053 807772 21:00 LDN CS G ZTM CEW 21:28")).toBe("401");
    expect(withoutLegacyOvChipNumber("63 53", "8006", "63 8006 44 6402 07:07 GnCS B2 LwoHaven 08:20")).toBe("63 53");
  });
});
