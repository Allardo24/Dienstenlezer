import type { TextItem } from "./types";
import { matchesBuslessAction } from "./buslessActions";

export type MovementColumnKey = "line" | "trip" | "loop" | "departure" | "from" | "to" | "arrival";
export type ColumnRange = readonly [number, number];
export type MovementColumnLayout = {
  ranges: Record<MovementColumnKey, ColumnRange>;
  useItemCenters: boolean;
};

export type TextRow = {
  items: TextItem[];
};

const DEFAULT_RANGES: Record<MovementColumnKey, ColumnRange> = {
  line: [35, 112],
  trip: [112, 178],
  loop: [178, 248],
  departure: [248, 312],
  from: [312, 420],
  to: [420, 510],
  arrival: [510, 575],
};

const HEADER_COLUMNS: Record<string, MovementColumnKey | "ignored"> = {
  lijn: "line",
  ovchip: "ignored",
  ritnr: "trip",
  ritnummer: "trip",
  omloop: "loop",
  vertrek: "departure",
  van: "from",
  naar: "to",
  aankomst: "arrival",
};

export function detectMovementColumnLayout(rows: TextRow[]): MovementColumnLayout {
  for (const row of rows) {
    const headers = row.items
      .map((item) => ({
        item,
        key: HEADER_COLUMNS[normaliseHeader(item.text)],
        center: item.x + item.width / 2,
      }))
      .filter((header) => header.key !== undefined)
      .sort((first, second) => first.center - second.center);
    const foundKeys = new Set(headers.map((header) => header.key));
    const requiredKeys: MovementColumnKey[] = ["line", "trip", "loop", "departure", "from", "to", "arrival"];
    if (!requiredKeys.every((key) => foundKeys.has(key))) {
      continue;
    }
    if (!foundKeys.has("ignored")) {
      return { ranges: DEFAULT_RANGES, useItemCenters: false };
    }

    const ranges = { ...DEFAULT_RANGES };
    headers.forEach((header, index) => {
      if (header.key === "ignored") {
        return;
      }
      const previousCenter = headers[index - 1]?.center;
      const nextCenter = headers[index + 1]?.center;
      ranges[header.key] = [
        previousCenter === undefined ? Number.NEGATIVE_INFINITY : (previousCenter + header.center) / 2,
        nextCenter === undefined ? Number.POSITIVE_INFINITY : (header.center + nextCenter) / 2,
      ];
    });

    return { ranges, useItemCenters: true };
  }

  return { ranges: DEFAULT_RANGES, useItemCenters: false };
}

export function textInMovementColumn(
  row: TextRow,
  [min, max]: ColumnRange,
  useItemCenters: boolean,
): string {
  return row.items
    .filter((item) => {
      const position = useItemCenters ? item.x + item.width / 2 : item.x;
      return position >= min && position < max;
    })
    .map((item) => item.text)
    .join(" ")
    .trim();
}

export function isBuslessDriverRow(raw: string, actions?: string[]): boolean {
  return matchesBuslessAction(raw, actions);
}

export function withoutLegacyOvChipNumber(
  lineNumber: string | undefined,
  tripNumber: string | undefined,
  raw: string,
): string | undefined {
  if (!lineNumber || !tripNumber) {
    return lineNumber;
  }

  const lineParts = lineNumber.trim().split(/\s+/);
  const rawParts = raw.trim().split(/\s+/);
  if (
    lineParts.length !== 2
    || !lineParts.every((part) => /^\d+$/.test(part))
    || rawParts[0] !== lineParts[0]
    || rawParts[1] !== lineParts[1]
    || rawParts[2] !== tripNumber.trim()
  ) {
    return lineNumber;
  }

  return lineParts[0];
}

function normaliseHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "");
}
