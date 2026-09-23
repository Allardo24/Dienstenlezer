import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { detectMovementColumnLayout, isBuslessDriverRow, textInMovementColumn } from "./pdfColumns";
import { extractMaterialType, isVehicleMovement, propagateMaterialByLoop } from "./materialType";
import type { Dienst, Movement, MovementType, ParseResult, TextItem } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

type PdfTextContentItem = {
  str: string;
  transform: number[];
  width?: number;
};

type Row = {
  y: number;
  items: TextItem[];
};

const TIME_RE = /^\d{1,2}:\d{2}$/;
const SERVICE_RE = /^(?:[A-Z]{1,3}-?)?\d{4,5}(?:[/-][A-Z0-9]+)*$/;
const SERVICE_LABEL_RE = /^dienst(?:nummer|nr)?\s*:?\s*$/i;
const INLINE_SERVICE_RE = /^dienst(?:nummer|nr)?(?:\s*:\s*|\s+)(\S+)\s*$/i;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

export async function parsePdfFiles(files: File[]): Promise<ParseResult[]> {
  const results: ParseResult[] = [];

  for (const file of files) {
    results.push(await parsePdfFile(file));
  }

  return results;
}

async function parsePdfFile(file: File): Promise<ParseResult> {
  const warnings: string[] = [];
  const diensten: Dienst[] = [];
  const movements: Movement[] = [];

  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const items = normaliseItems(textContent.items as PdfTextContentItem[]);

      if (items.length === 0) {
        warnings.push(`${file.name} pagina ${pageNumber}: geen tekstlaag gevonden.`);
        continue;
      }

      const rows = groupRows(items);
      const dienst = readDienst(file.name, pageNumber, rows, items);
      diensten.push(dienst);
      movements.push(...readMovements(file.name, pageNumber, rows, dienst));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${file.name}: kon pdf niet uitlezen (${message}).`);
  }

  return { fileName: file.name, diensten, movements: propagateMaterialByLoop(movements), warnings };
}

function normaliseItems(items: PdfTextContentItem[]): TextItem[] {
  return items
    .map((item) => ({
      text: item.str.trim(),
      x: item.transform[4],
      y: item.transform[5],
      width: item.width ?? 0,
    }))
    .filter((item) => item.text.length > 0);
}

function groupRows(items: TextItem[]): Row[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];

  for (const item of sorted) {
    const row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 4);

    if (row) {
      row.items.push(item);
      row.y = (row.y + item.y) / 2;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  return rows
    .map((row) => ({
      ...row,
      items: row.items.sort((a, b) => a.x - b.x),
    }))
    .sort((a, b) => b.y - a.y);
}

function readDienst(sourceFile: string, pageNumber: number, rows: Row[], items: TextItem[]): Dienst {
  const topRows = headerRows(rows, items);
  const serviceNumber = findServiceNumber(rows, topRows) ?? `pagina-${pageNumber}`;

  const date = items.find((item) => DATE_RE.test(item.text))?.text;
  const location = detectServiceDepot(items);

  const metaRow = rows.find((row) => row.items.some((item) => item.text === "Start:"));
  const metaTimes = metaRow?.items.filter((item) => TIME_RE.test(item.text)).map((item) => item.text) ?? [];
  const length = metaRow?.items.find((item) => /^\d+u\d{2}$/.test(item.text))?.text;
  return {
    id: `${sourceFile}-${pageNumber}-${serviceNumber}`,
    serviceNumber,
    sourceFile,
    pageNumber,
    date,
    location,
    depot: location,
    start: metaTimes[0],
    end: metaTimes[1],
    length,
  };
}

export function detectServiceDepot(items: TextItem[]): string | undefined {
  if (!items.length) return undefined;
  const rows = headerRows(groupRows(items), items);
  const serviceNumber = findServiceNumber(rows, rows);
  const headerItems = rows.flatMap((row) => row.items);
  const service = headerItems.find((item) => item.text === serviceNumber || INLINE_SERVICE_RE.test(item.text));
  const date = headerItems.find((item) => DATE_RE.test(item.text));
  const clean = (parts: TextItem[]) => parts.map((item) => item.text).join(" ")
    .replace(/\s+/g, " ").replace(/\s+,/g, ",").trim() || undefined;

  for (const row of rows) {
    const label = row.items.findIndex((item) => /^(stalling|standplaats|locatie)\s*:/i.test(item.text));
    if (label >= 0) {
      const parts = row.items.slice(label).filter((item) => !DATE_RE.test(item.text) && !/^qbuzz$/i.test(item.text));
      const value = clean(parts)?.replace(/^(stalling|standplaats|locatie)\s*:\s*/i, "");
      if (value) return value;
    }
  }
  if (!service || !date) return undefined;
  // The depot occupies the header cell above the date and right of the duty number.
  const candidates = rows.filter((row) => row.y > date.y + 4 && row.y >= service.y - 4);
  for (const row of candidates.sort((a, b) => Math.abs(a.y - service.y) - Math.abs(b.y - service.y))) {
    const parts = row.items.filter((item) => item.x >= service.x + service.width / 2
      && !/^qbuzz$/i.test(item.text) && !DATE_RE.test(item.text)
      && !SERVICE_RE.test(item.text) && /[a-z]/i.test(item.text)
      && !/^(ma-vr|za|zo|start|einde|lengte|dienst)\b/i.test(item.text));
    const value = clean(parts);
    if (value) return value;
  }
  return undefined;
}

export function detectServiceNumber(items: TextItem[], pageNumber = 1): string {
  const rows = groupRows(items);
  return findServiceNumber(rows, headerRows(rows, items)) ?? `pagina-${pageNumber}`;
}

function isLabelledServiceNumber(value: string): boolean {
  // The explicit header label allows more formats than the unlabelled fallback.
  return value.length <= 32 && /\d/.test(value)
    && /^[a-z0-9]+(?:[-/._][a-z0-9]+)*$/i.test(value)
    && !DATE_RE.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value);
}

function findServiceNumber(_rows: Row[], topRows: Row[]): string | undefined {
  for (const row of topRows) {
    for (const item of row.items) {
      const inlineMatch = item.text.match(INLINE_SERVICE_RE);
      if (inlineMatch && isLabelledServiceNumber(inlineMatch[1])) {
        return inlineMatch[1];
      }
      if (!SERVICE_LABEL_RE.test(item.text)) {
        continue;
      }

      const candidates = row.items
        .filter((candidate) => candidate !== item && isLabelledServiceNumber(candidate.text))
        .sort((first, second) => {
          const firstIsRight = first.x >= item.x ? 0 : 1;
          const secondIsRight = second.x >= item.x ? 0 : 1;
          return firstIsRight - secondIsRight || Math.abs(first.x - item.x) - Math.abs(second.x - item.x);
        });
      if (candidates[0]) {
        return candidates[0].text;
      }
    }
  }

  const flattenedTop = topRows.flatMap((row) => row.items);
  return flattenedTop.find((item) => SERVICE_RE.test(item.text) && item.x > 90 && item.x < 190)?.text
    ?? flattenedTop.find((item) => SERVICE_RE.test(item.text))?.text;
}

function headerRows(rows: Row[], items: TextItem[]): Row[] {
  const tableHeaderIndex = rows.findIndex((row) => {
    const labels = new Set(row.items.map((item) => item.text.toLowerCase().replace(/[^a-z]/g, "")));
    return labels.has("lijn") && labels.has("vertrek") && labels.has("aankomst");
  });
  if (tableHeaderIndex >= 0) {
    return rows.slice(0, tableHeaderIndex);
  }

  const yValues = items.map((item) => item.y);
  const highestY = Math.max(...yValues);
  const lowestY = Math.min(...yValues);
  const topBandHeight = Math.max(80, (highestY - lowestY) * 0.2);
  return rows.filter((row) => row.y >= highestY - topBandHeight);
}

function readMovements(sourceFile: string, pageNumber: number, rows: Row[], dienst: Dienst): Movement[] {
  const dataRows = rows.filter((row) => row.y < 730 && row.y > 35);
  const columns = detectMovementColumnLayout(rows);
  const movements: Movement[] = [];
  let lastKnownOmloop: string | undefined;
  let pendingMaterialType: string | undefined;
  const materialByLoop = new Map<string, string>();

  for (const row of dataRows) {
    const readColumn = (key: keyof typeof columns.ranges) => textInMovementColumn(
      row,
      columns.ranges[key],
      columns.useItemCenters,
    );
    const vertrek = readColumn("departure");
    const aankomst = readColumn("arrival");
    const raw = row.items.map((item) => item.text).join(" ");

    if (!TIME_RE.test(vertrek) || !TIME_RE.test(aankomst)) {
      pendingMaterialType = extractMaterialType(raw) ?? pendingMaterialType;
      continue;
    }

    const buslessDriverAction = isBuslessDriverRow(raw);
    const lijnnummer = readColumn("line");
    const ritnummer = readColumn("trip");
    const explicitOmloopnummer = readColumn("loop");
    const omloopnummer = buslessDriverAction ? undefined : explicitOmloopnummer || lastKnownOmloop;
    const van = readColumn("from");
    const naar = readColumn("to");
    const type = buslessDriverAction ? "dienst" : detectType(lijnnummer, ritnummer, omloopnummer, van, naar);

    if (!buslessDriverAction && explicitOmloopnummer && pendingMaterialType) {
      materialByLoop.set(explicitOmloopnummer, pendingMaterialType);
      pendingMaterialType = undefined;
    }
    const materieelsoort = isVehicleMovement(type) && omloopnummer
      ? materialByLoop.get(omloopnummer)
      : undefined;

    if (buslessDriverAction) {
      lastKnownOmloop = undefined;
    } else if (explicitOmloopnummer) {
      lastKnownOmloop = explicitOmloopnummer;
    }

    movements.push({
      id: `${sourceFile}-${pageNumber}-${dienst.serviceNumber}-${movements.length}`,
      sourceFile,
      pageNumber,
      dienstnummer: dienst.serviceNumber,
      datum: dienst.date,
      omloopnummer: omloopnummer || undefined,
      lijnnummer: lijnnummer || undefined,
      ritnummer: ritnummer || undefined,
      materieelsoort,
      vertrek,
      aankomst,
      van,
      naar,
      type,
      raw,
    });

    // Vanaf "Bus aan lader" is de bus terug in de garage. Volgende
    // chauffeuracties mogen daarom niet meer de oude omloop erven.
    if (isBusReturnedToGarage(raw, van, naar)) {
      lastKnownOmloop = undefined;
      if (omloopnummer) {
        materialByLoop.delete(omloopnummer);
      }
    }
  }

  return movements;
}

function isBusReturnedToGarage(raw: string, van: string, naar: string): boolean {
  return `${raw} ${van} ${naar}`.toLowerCase().includes("bus aan lader");
}

function detectType(
  lijnnummer: string,
  ritnummer: string,
  omloopnummer: string | undefined,
  van: string,
  naar: string,
): MovementType {
  const label = `${van} ${naar}`.toLowerCase();

  if (label.includes("pauze")) {
    return "pauze";
  }

  if (lijnnummer === "MAT" || label.includes("lader")) {
    return "materiaal";
  }

  if (label.includes("opstap") || label.includes("afstap") || label.includes("explo") || label.includes("lopen")) {
    return "dienst";
  }

  if (lijnnummer || ritnummer || omloopnummer) {
    return "rit";
  }

  return "overig";
}
