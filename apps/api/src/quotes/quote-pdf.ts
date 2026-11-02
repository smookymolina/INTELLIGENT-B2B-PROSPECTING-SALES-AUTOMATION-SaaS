import type { QuoteDetailDto } from "@prospecting/contracts";

/**
 * Renderer PDF mínimo y determinista, sin dependencias (Helvetica estándar, WinAnsi). Los importes se imprimen tal cual vienen
 * del servidor (cadenas decimales ya calculadas y verificadas por PostgreSQL): aquí no se recalcula nada.
 */
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const LINE_H = 14;

/** Sólo Latin-1 imprimible; el resto se sustituye por «?». Escapa los delimitadores de cadena PDF. */
export function pdfText(s: string): string {
  let out = "";
  for (const ch of s.replace(/[\r\n\t]+/g, " ")) {
    const c = ch.codePointAt(0) ?? 63;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (c >= 32 && c <= 126) out += ch;
    else if (c >= 160 && c <= 255) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}.` : s);

type Row = { x: number; text: string; bold?: boolean; right?: boolean }[];

function cols(q: QuoteDetailDto): Row[] {
  const rows: Row[] = [];
  const head: Row = [
    { x: MARGIN, text: "SKU", bold: true },
    { x: 120, text: "Concepto", bold: true },
    { x: 320, text: "Cant.", bold: true, right: true },
    { x: 385, text: "Precio", bold: true, right: true },
    { x: 440, text: "Dto %", bold: true, right: true },
    { x: PAGE_W - MARGIN, text: "Total", bold: true, right: true },
  ];
  rows.push(head);
  for (const l of q.lines) {
    rows.push([
      { x: MARGIN, text: clip(l.sku, 11) },
      { x: 120, text: clip(l.itemName, 38) },
      { x: 320, text: l.quantity, right: true },
      { x: 385, text: l.unitPrice, right: true },
      { x: 440, text: l.discountPercent, right: true },
      { x: PAGE_W - MARGIN, text: l.lineTotal, right: true },
    ]);
  }
  return rows;
}

/** Aproximación de ancho Helvetica (0,5 em) sólo para alinear a la derecha. */
const width = (t: string, size: number): number => t.length * size * 0.5;

export function renderQuotePdf(q: QuoteDetailDto, orgName: string): Buffer {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const put = (x: number, text: string, bold = false, size = 10, right = false) => {
    const px = right ? x - width(text, size) : x;
    pages[pages.length - 1]!.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${px.toFixed(1)} ${y.toFixed(1)} Td (${pdfText(text)}) Tj ET`);
  };
  const next = (h = LINE_H) => {
    y -= h;
    if (y < MARGIN + 80) {
      pages.push([]);
      y = PAGE_H - MARGIN;
    }
  };

  put(MARGIN, orgName, true, 14);
  next(22);
  put(MARGIN, `Cotizacion #${q.number} - ${q.label}`, true, 12);
  next(18);
  put(MARGIN, `Estado: ${q.status}   Moneda: ${q.currency}   Valida hasta: ${q.validUntil ?? "sin fecha"}`);
  next(24);
  for (const row of cols(q)) {
    for (const c of row) put(c.x, c.text, c.bold, 9, c.right);
    next();
  }
  next(6);
  const totalsRows: [string, string][] = [
    ["Subtotal", q.subtotal],
    ["Descuentos", q.discountTotal],
    [q.taxRate === null ? "Impuesto" : `Impuesto (${q.taxRate}%)`, q.taxTotal],
    ["TOTAL", q.total],
  ];
  for (const [label, value] of totalsRows) {
    put(400, label, label === "TOTAL", 10);
    put(PAGE_W - MARGIN, `${value} ${q.currency}`, label === "TOTAL", 10, true);
    next();
  }
  if (q.notes) {
    next(10);
    put(MARGIN, "Notas", true);
    next();
    for (let i = 0; i < q.notes.length; i += 95) {
      put(MARGIN, q.notes.slice(i, i + 95), false, 9);
      next(12);
    }
  }

  // Estructura: 1 catálogo, 2 páginas, 3-4 fuentes, luego (página, contenido) por página.
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((ops, i) => {
    const stream = ops.join("\n");
    objs[5 + i * 2] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    objs[6 + i * 2] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objs.length; n++) {
    offsets[n] = Buffer.byteLength(out, "latin1");
    out += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objs.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
