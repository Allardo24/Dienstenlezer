import type { Dienst, Movement, ParseResult, TextItem } from "./types";

type Row = { y: number; items: TextItem[] };
const TIME = /^\d{1,2}:\d{2}$/;

function rowsFor(items: TextItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let row = rows.find((candidate) => Math.abs(candidate.y - item.y) <= 4);
    if (!row) {
      row = { y: item.y, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }
  return rows.map((row) => ({ ...row, items: row.items.sort((a, b) => a.x - b.x) }))
    .sort((a, b) => b.y - a.y);
}

function content(row: Row): string {
  return row.items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
}

export function isTransdevPage(items: TextItem[]): boolean {
  const rows = rowsFor(items);
  const text = rows.map(content);
  return text.some((row) => /^Ingangsdatum\s+\d{2}-\d{2}-\d{4}\b/i.test(row))
    && text.some((row) => /^Dienst\s+[A-Z]{1,3}\s+\d{3,6}\b/i.test(row))
    && text.some((row) => /\bLijn\s+Omloop\s+Rit\s+Aanv\.?\s+Van\s+Naar\s+Einde\b/i.test(row));
}

export function parseTransdevPage(sourceFile: string, pageNumber: number, items: TextItem[]): ParseResult {
  const rows = rowsFor(items);
  const warnings: string[] = [];
  const header = rows.find((row) => /^Dienst\s+/i.test(content(row)));
  const match = header && content(header).match(/^Dienst\s+([A-Z]{1,3})\s+(\d{3,6})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s+(\d{1,2}:\d{2})/i);
  const tableIndex = rows.findIndex((row) => /\bLijn\s+Omloop\s+Rit\s+Aanv\.?\s+Van\s+Naar\s+Einde\b/i.test(content(row)));
  if (!match || tableIndex < 0) {
    return { fileName: sourceFile, operator: "transdev", diensten: [], movements: [],
      warnings: [`${sourceFile} pagina ${pageNumber}: Transdev-dienstkop of kolommen niet herkend.`] };
  }

  // Het boekje verschuift de volledige tabel op even pagina's 48 punten naar links.
  const columnOffset = (rows[tableIndex].items.find((item) => /^Lijn$/i.test(item.text))?.x ?? 83) - 83;

  const serviceNumber = match[2];
  const location = rows.slice(0, tableIndex).map(content)
    .find((row) => /^MA\/DI\/WO\/DO\/VR\s+/i.test(row))
    ?.replace(/^MA\/DI\/WO\/DO\/VR\s+/i, "");
  const dienst: Dienst = {
    id: `${sourceFile}-${pageNumber}-${serviceNumber}`,
    sourceFile, pageNumber, serviceNumber, location, depot: location,
    start: match[3], end: match[4], length: match[5],
  };
  const movements: Movement[] = [];
  let lastLoop: string | undefined;
  for (const row of rows.slice(tableIndex + 1)) {
    const byColumn = (min: number, max: number) => row.items
      .filter((item) => item.x + item.width / 2 - columnOffset >= min && item.x + item.width / 2 - columnOffset < max)
      .map((item) => item.text).join(" ").trim();
    const raw = content(row);
    const label = byColumn(0, 255);
    const explicitLoop = byColumn(255, 320);
    const trip = byColumn(320, 355);
    const departure = byColumn(355, 390);
    const from = byColumn(390, 460);
    const to = byColumn(460, 525);
    const arrival = byColumn(525, 600);
    if (!TIME.test(departure) || !TIME.test(arrival)) continue;
    if (/^Op\/Afstaptijd$/i.test(label)) {
      lastLoop = undefined;
      continue;
    }
    const isLine = /^\d+[A-Z]?$/.test(label);
    const isMaterial = /^MAT$/i.test(label);
    const isPause = /^(Pauze|Onderbreking)\b/i.test(raw);
    const isDriverAction = /^(Lopen|Aflosauto|Lost af|Afgel door)\b|^Pass\./i.test(raw)
      || /^\d{1,2}:\d{2}\s+\d{1,2}:\d{2}$/.test(raw);
    if (!isLine && !isMaterial && !isPause && !isDriverAction) {
      warnings.push(`${sourceFile} pagina ${pageNumber}: regel niet herkend: ${raw}`);
      continue;
    }
    if (explicitLoop) lastLoop = explicitLoop;
    const type = isLine ? "rit" : isMaterial ? "materiaal" : isPause ? "pauze" : "dienst";
    movements.push({
      id: `${sourceFile}-${pageNumber}-${serviceNumber}-${movements.length}`,
      sourceFile, pageNumber, dienstnummer: serviceNumber,
      lijnnummer: isLine ? label : isMaterial ? "MAT" : undefined,
      omloopnummer: isLine || isMaterial ? lastLoop : undefined,
      ritnummer: isLine && trip ? trip : undefined,
      vertrek: departure, aankomst: arrival, van: from, naar: to, type, raw,
    });
    if (isPause || isDriverAction) lastLoop = undefined;
  }
  return { fileName: sourceFile, operator: "transdev", diensten: [dienst], movements, warnings };
}
