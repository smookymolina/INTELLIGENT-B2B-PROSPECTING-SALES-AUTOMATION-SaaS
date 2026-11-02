import type { LoggerService, LogLevel } from "@nestjs/common";

const SECRET_KV = /\b(password|passwd|secret|token|authorization|api[_-]?key|cookie|set-cookie)\b(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

/** Masks credentials and personal identifiers before a message reaches stdout. Conservative: it may over-redact, never under-redact the listed shapes. */
export function redact(text: string): string {
  return text
    .replace(BEARER, "Bearer [REDACTED]")
    .replace(JWT, "[REDACTED_JWT]")
    .replace(SECRET_KV, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`)
    .replace(EMAIL, "[REDACTED_EMAIL]");
}

const stringify = (m: unknown): string => {
  if (typeof m === "string") return m;
  if (m instanceof Error) return `${m.name}: ${m.message}`; // never the stack: it can embed values
  try {
    return JSON.stringify(m) ?? String(m);
  } catch {
    return "[unserializable]";
  }
};

type Sink = (line: string) => void;

/** One JSON object per line (`ts`, `level`, `context`, `msg`) with redaction, so logs are machine-parseable and safe to ship. */
export class StructuredLogger implements LoggerService {
  constructor(
    private readonly sink: Sink = (line) => process.stdout.write(`${line}\n`),
    private readonly levels: ReadonlySet<LogLevel> = new Set<LogLevel>(["log", "error", "warn"]),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private emit(level: LogLevel, message: unknown, optional: unknown[]): void {
    if (!this.levels.has(level)) return;
    const last = optional[optional.length - 1];
    const context = typeof last === "string" ? last : undefined; // Nest passes the context as the last string argument
    const extra = (context === undefined ? optional : optional.slice(0, -1)).map(stringify);
    const msg = redact([stringify(message), ...extra].join(" "));
    this.sink(JSON.stringify({ ts: this.now().toISOString(), level, ...(context ? { context } : {}), msg }));
  }

  log(message: unknown, ...optional: unknown[]): void { this.emit("log", message, optional); }
  error(message: unknown, ...optional: unknown[]): void { this.emit("error", message, optional); }
  warn(message: unknown, ...optional: unknown[]): void { this.emit("warn", message, optional); }
  debug(message: unknown, ...optional: unknown[]): void { this.emit("debug", message, optional); }
  verbose(message: unknown, ...optional: unknown[]): void { this.emit("verbose", message, optional); }
}
