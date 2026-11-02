import { describe, expect, it } from "vitest";
import type { QuoteDetailDto } from "@prospecting/contracts";
import { pdfText, renderQuotePdf } from "./quote-pdf.js";

const line = (n: number) => ({ id: "l" + n, sku: "SKU" + n, itemName: "Item (" + n + ")", quantity: "2.0000", unitPrice: "10.0000", discountPercent: "0.00", lineTotal: "20.0000" }) as unknown as QuoteDetailDto["lines"][number];
const quote = (lines: number, notes: string | null = null) =>
  ({ number: 7, label: "Año 1", status: "draft", currency: "USD", validUntil: null, taxRate: "16.0000", notes, subtotal: "20.0000", discountTotal: "0.0000", taxTotal: "3.2000", total: "23.2000", lines: Array.from({ length: lines }, (_, i) => line(i)) }) as unknown as QuoteDetailDto;

const BS = String.fromCharCode(92);

describe("quote pdf", () => {
  it("escapa delimitadores y sustituye caracteres fuera de Latin-1", () => {
    expect(pdfText(`a(b)${BS}c`)).toBe(`a${BS}(b${BS})${BS}${BS}c`);
    expect(pdfText("€")).toBe("?");
    expect(pdfText("ñ")).toBe(`${BS}361`);
  });
  it("genera un PDF válido con importes del servidor y xref correcto", () => {
    const buf = renderQuotePdf(quote(2, "Condiciones"), "ACME (SA)");
    const s = buf.toString("latin1");
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("23.2000 USD");
    expect(s).toContain(`ACME ${BS}(SA${BS})`);
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    const off = Number(/\n(\d{10}) 00000 n \n/.exec(s)![1]);
    expect(s.slice(off, off + 7)).toBe("1 0 obj");
  });
  it("pagina cuando hay muchas líneas", () => {
    const s = renderQuotePdf(quote(120), "ACME").toString("latin1");
    expect(/\/Count (\d+)/.exec(s)![1]).not.toBe("1");
  });
});
