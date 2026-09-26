import { expect, it } from "vitest";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { readPdfTextItems } from "./pdfText";

const chunk = (str: string): TextContent => ({
  items: [{ str, dir: "ltr", transform: [1, 0, 0, 1, 0, 0], width: 10, height: 10, fontName: "test", hasEOL: false }],
  styles: {}, lang: null,
});

it("leest alle tekstchunks zonder async iterator, zoals op Safari", async () => {
  const stream = new ReadableStream<TextContent>({ start(controller) {
    controller.enqueue(chunk("Dienst:")); controller.enqueue(chunk("P-7156/2")); controller.close();
  } });
  Object.defineProperty(stream, Symbol.asyncIterator, { value: undefined });
  expect(await readPdfTextItems({ streamTextContent: () => stream })).toEqual([...chunk("Dienst:").items, ...chunk("P-7156/2").items]);
  expect(stream.locked).toBe(false);
});

it("geeft een echte leesfout door en geeft de stream vrij", async () => {
  const stream = new ReadableStream<TextContent>({ start(controller) { controller.error(new Error("kapotte PDF")); } });
  await expect(readPdfTextItems({ streamTextContent: () => stream })).rejects.toThrow("kapotte PDF");
  expect(stream.locked).toBe(false);
});

it("behoudt lege tekst bij een PDF zonder tekstlaag", async () => {
  const stream = new ReadableStream<TextContent>({ start(controller) { controller.close(); } });
  expect(await readPdfTextItems({ streamTextContent: () => stream })).toEqual([]);
});
