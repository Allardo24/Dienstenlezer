import * as pdfjsLib from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.mjs?url";
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
const SERVICE_RE = /^[A-Z]?\d{4,5}$/;
const DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

const COLS = {
  line: [35, 112],
  trip: [112, 178],
  loop: [178, 248],
  departure: [248, 312],
  from: [312, 420],
  to: [420, 510],
  arrival: [510, 575],
} as const;

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

  return { fileName: file.name, diensten, movements, warnings };
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
  const topRows = rows.filter((row) => row.y > 735);
  const flattenedTop = topRows.flatMap((row) => row.items);
  const serviceItem =
    flattenedTop.find((item) => SERVICE_RE.test(item.text) && item.x > 90 && item.x < 190) ??
    items.find((item) => SERVICE_RE.test(item.text));

  const date = items.find((item) => DATE_RE.test(item.text))?.text;
  const location = topRows
    .flatMap((row) => row.items)
    .find((item) => item.x > 250 && item.x < 360 && !DATE_RE.test(item.text))?.text;

  const metaRow = rows.find((row) => row.items.some((item) => item.text === "Start:"));
  const metaTimes = metaRow?.items.filter((item) => TIME_RE.test(item.text)).map((item) => item.text) ?? [];
  const length = metaRow?.items.find((item) => /^\d+u\d{2}$/.test(item.text))?.text;
  const serviceNumber = serviceItem?.text ?? `pagina-${pageNumber}`;

  return {
    id: `${sourceFile}-${pageNumber}-${serviceNumber}`,
    serviceNumber,
    sourceFile,
    pageNumber,
    date,
    location,
    start: metaTimes[0],
    end: metaTimes[1],
    length,
  };
}

function readMovements(sourceFile: string, pageNumber: number, rows: Row[], dienst: Dienst): Movement[] {
  const dataRows = rows.filter((row) => row.y < 730 && row.y > 35);
  const movements: Movement[] = [];
  let lastKnownOmloop: string | undefined;

  for (const row of dataRows) {
    const vertrek = textIn(row, COLS.departure);
    const aankomst = textIn(row, COLS.arrival);

    if (!TIME_RE.test(vertrek) || !TIME_RE.test(aankomst)) {
      continue;
    }

    const lijnnummer = textIn(row, COLS.line);
    const ritnummer = textIn(row, COLS.trip);
    const explicitOmloopnummer = textIn(row, COLS.loop);
    const omloopnummer = explicitOmloopnummer || lastKnownOmloop;
    const van = textIn(row, COLS.from);
    const naar = textIn(row, COLS.to);
    const type = detectType(lijnnummer, ritnummer, omloopnummer, van, naar);
    const raw = row.items.map((item) => item.text).join(" ");

    if (explicitOmloopnummer) {
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
    }
  }

  return movements;
}

function isBusReturnedToGarage(raw: string, van: string, naar: string): boolean {
  return `${raw} ${van} ${naar}`.toLowerCase().includes("bus aan lader");
}

function textIn(row: Row, [min, max]: readonly [number, number]): string {
  return row.items
    .filter((item) => item.x >= min && item.x < max)
    .map((item) => item.text)
    .join(" ")
    .trim();
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
