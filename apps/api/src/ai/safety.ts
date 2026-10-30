/**
 * Guardrails around model calls (docs/ai/AI_ARCHITECTURE.md). All pure functions so they are unit-tested without a model.
 * Heuristics reduce risk, they do not eliminate it: anything they cannot rule out ends in human review, never in an automatic action.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/gi;
const PHONE = /(?<![\w])\+?\d[\d\s().-]{7,}\d(?![\w])/g;
const LONG_DIGITS = /\b\d{9,}\b/g;

/** Minimisation before anything leaves the system: contact data and identifiers are replaced, the count is reported. */
export function redactPii(text: string): { text: string; count: number } {
  let count = 0;
  const swap = (re: RegExp, tag: string) => {
    text = text.replace(re, () => {
      count += 1;
      return tag;
    });
  };
  swap(CREDENTIAL_URL, "[url-redacted]");
  swap(EMAIL, "[email-redacted]");
  swap(PHONE, "[phone-redacted]");
  swap(LONG_DIGITS, "[number-redacted]");
  return { text, count };
}

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(the\s+|all\s+)?(system|previous|prior|above)/i,
  /\byou\s+are\s+now\b/i,
  /\b(reveal|show|print|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions?)/i,
  /\bsystem\s+prompt\b/i,
  /\bact\s+as\s+(an?\s+)?(admin|administrator|developer|root|dan)\b/i,
  /<\/?\s*(system|assistant|instructions?|evidence|untrusted)\s*>/i,
  /\b(begin|end)\s+(system|prompt|instructions?)\b/i,
  /olvida\s+(todas\s+)?las\s+instrucciones/i,
  /ignora\s+(todas\s+)?las\s+instrucciones/i,
];
export const looksLikeInjection = (text: string): boolean => INJECTION_PATTERNS.some((re) => re.test(text));

/** Untrusted text is quoted as data: angle brackets cannot close the delimiter that wraps it. */
export const neutraliseDelimiters = (text: string): string => text.replace(/[<>]/g, " ");

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const canon = (n: string): string => String(Number(n.replace(/,/g, "")));

/**
 * Numbers in a model answer must be traceable: present in the approved evidence or in the (redacted) customer text.
 * Anything else is an invented figure (a price, a quantity) and forces human review. Single digits are ignored (ordinals, "1 of 2").
 */
export function ungroundedNumbers(answer: string, ...sources: string[]): string[] {
  const known = new Set(sources.flatMap((s) => (s.match(NUMBER) ?? []).map(canon)));
  const bad = new Set<string>();
  for (const n of answer.match(NUMBER) ?? []) {
    const c = canon(n);
    if (c.replace(/\D/g, "").length < 2) continue;
    if (!known.has(c)) bad.add(n);
  }
  return [...bad];
}

/** Models sometimes wrap JSON in a fence; accept that, nothing else. */
export function extractJson(raw: string): unknown {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(raw.trim());
  return JSON.parse(fenced ? (fenced[1] as string) : raw.trim());
}
