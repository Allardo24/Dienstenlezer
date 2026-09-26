import type { PDFPageProxy, TextContent } from "pdfjs-dist/types/src/display/api";

export async function readPdfTextItems(page: Pick<PDFPageProxy, "streamTextContent">): Promise<TextContent["items"]> {
  // Safari supports stream readers but not every version supports async stream iteration.
  const reader = page.streamTextContent().getReader();
  const items: TextContent["items"] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return items;
      for (const item of value.items) items.push(item);
    }
  } finally {
    reader.releaseLock();
  }
}
