/** Pure time-window maths for sequences (no I/O). A window is a daily [start, end) in minutes of a campaign's IANA time zone, on ISO weekdays 1 (Mon) .. 7 (Sun). */
export type Window = Readonly<{ timezone: string; startMin: number; endMin: number; weekdays: readonly number[] }>;

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timezone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
    fmtCache.set(timezone, f);
  }
  return f;
}

export type LocalParts = { year: number; month: number; day: number; minutes: number; weekday: number };

export function localParts(at: Date, timezone: string): LocalParts {
  const p: Record<string, string> = {};
  for (const part of fmt(timezone).formatToParts(at)) p[part.type] = part.value;
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), minutes: Number(p.hour) * 60 + Number(p.minute), weekday: WEEKDAYS[p.weekday ?? ""] ?? 1 };
}

/** Offset (ms) of `timezone` from UTC at the instant `at`. */
function offsetAt(at: Date, timezone: string): number {
  const l = localParts(at, timezone);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, Math.floor(l.minutes / 60), l.minutes % 60);
  return asUtc - Math.floor(at.getTime() / 60_000) * 60_000;
}

/** The instant at which the wall clock of `timezone` reads y-m-d + `minutes` (second pass handles a DST change between guess and answer). */
export function zonedInstant(year: number, month: number, day: number, minutes: number, timezone: string): Date {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  const first = guess - offsetAt(new Date(guess), timezone);
  return new Date(guess - offsetAt(new Date(first), timezone));
}

export function insideWindow(at: Date, w: Window): boolean {
  const l = localParts(at, w.timezone);
  return w.weekdays.includes(l.weekday) && l.minutes >= w.startMin && l.minutes < w.endMin;
}

/** The earliest instant >= `from` that is inside the window (`from` itself when it already is). */
export function nextAllowed(from: Date, w: Window): Date {
  if (insideWindow(from, w)) return from;
  const l = localParts(from, w.timezone);
  if (w.weekdays.includes(l.weekday) && l.minutes < w.startMin) return zonedInstant(l.year, l.month, l.day, w.startMin, w.timezone);
  for (let k = 1; k <= 8; k += 1) {
    const d = new Date(Date.UTC(l.year, l.month - 1, l.day + k));
    const iso = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
    if (w.weekdays.includes(iso)) return zonedInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), w.startMin, w.timezone);
  }
  throw new Error("unreachable: a window has at least one weekday");
}

export const toMinutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
export const fromMinutes = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
