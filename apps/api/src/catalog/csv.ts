/** Minimal RFC 4180 reader: quoted fields, escaped quotes, embedded newlines, CRLF/LF/CR, BOM. Comma-delimited only. */
export class CsvError extends Error {
  constructor(
    readonly code: "empty" | "unterminated_quote" | "stray_quote" | "control_character" | "too_many_rows" | "too_many_columns" | "field_too_long",
    message: string,
    readonly line?: number,
  ) {
    super(message);
  }
}

export type CsvLimits = Readonly<{ maxRows: number; maxColumns: number; maxFieldLength: number }>;

export function parseCsv(input: string, limits: CsvLimits): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // distinguishes an empty quoted field ("") from no field
  let closed = false; // a quoted field just ended: only a delimiter or newline may follow
  let line = 1;

  const endField = () => {
    if (field.length > limits.maxFieldLength) throw new CsvError("field_too_long", "A field exceeds the maximum length", line);
    record.push(field);
    if (record.length > limits.maxColumns) throw new CsvError("too_many_columns", "Too many columns", line);
    field = "";
    fieldStarted = false;
    closed = false;
  };
  const endRecord = () => {
    endField();
    if (!(record.length === 1 && record[0] === "")) records.push(record); // skip blank lines
    record = [];
    if (records.length > limits.maxRows + 1) throw new CsvError("too_many_rows", "Too many rows", line);
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === "\u0000") throw new CsvError("control_character", "NUL characters are not allowed", line);
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          closed = true;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (fieldStarted || field.length > 0) throw new CsvError("stray_quote", "A quote appears inside an unquoted field", line);
      inQuotes = true;
      fieldStarted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
      line++;
    } else {
      if (closed) {
        throw new CsvError("stray_quote", "Unexpected characters after a closing quote", line);
      }
      field += ch;
      fieldStarted = true;
    }
  }
  if (inQuotes) throw new CsvError("unterminated_quote", "A quoted field is not closed", line);
  if (field.length > 0 || fieldStarted || record.length > 0) endRecord();
  if (records.length === 0) throw new CsvError("empty", "The file has no rows");
  return records;
}
