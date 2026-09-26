import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { parsePdfFiles } from "./pdfParser";

function fixture() {
  const labels = [
    [48,798,"Dienst:"],[129,798,"P-7156/2"],[272,804,"Katwijk, Garage"],[289,780,"22/09/2026"],
    [48,756,"Start:"],[115,756,"12:17"],[221,756,"Einde:"],[270,756,"17:33"],
    [48,735,"Lijn"],[117,735,"Ritnr"],[192,735,"Omloop"],[270,735,"Vertrek"],[327,735,"Van"],[444,735,"Naar"],[515,735,"Aankomst"],
    [48,650,"385"],[117,650,"1057"],[192,650,"807754"],[270,650,"12:31"],[327,650,"KWK ESA"],[444,650,"DHG CS"],[515,650,"13:13"],
  ];
  const content = labels.map(([x,y,text]) => `BT /F1 10 Tf ${x} ${y} Td (${text}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}

it("reproduceert PDF.js-fout en leest dezelfde dienst zonder Safari-streamiterator", async () => {
  GlobalWorkerOptions.workerSrc = pathToFileURL(createRequire(import.meta.url).resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  const bytes = fixture();
  const file = () => new File([bytes], "dienst.pdf", { type: "application/pdf" });
  const expected = await parsePdfFiles([file()]);
  expect(expected[0].warnings).toEqual([]);
  expect(expected[0].diensten[0].serviceNumber).toBe("P-7156/2");
  expect(expected[0].movements).toHaveLength(1);
  const iterator = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);
  const task = getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  try {
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, value: undefined });
    const page = await pdf.getPage(1);
    await expect(page.getTextContent()).rejects.toThrow(TypeError);
    expect(await parsePdfFiles([file()])).toEqual(expected);
  } finally {
    if (iterator) Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, iterator);
    else delete ReadableStream.prototype[Symbol.asyncIterator];
    await task.destroy();
  }
});
