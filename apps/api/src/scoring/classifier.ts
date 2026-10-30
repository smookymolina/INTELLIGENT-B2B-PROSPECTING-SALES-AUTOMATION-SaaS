import type { INTENT_CLASSES } from "@prospecting/contracts";

export type IntentClass = (typeof INTENT_CLASSES)[number];
export const CLASSIFIER_VERSION = "rules-v1";

/** Phrase dictionary (accent- and case-insensitive). Changing it requires a new CLASSIFIER_VERSION so past assessments stay explainable. */
const DICTIONARY: Record<Exclude<IntentClass, "irrelevant" | "review">, string[]> = {
  unsubscribe: ["darse de baja", "dar de baja", "darme de baja", "baja de la lista", "no me contacten", "no vuelvan a escribir", "no me escriban mas", "cancelar suscripcion", "unsubscribe", "remove me", "stop emailing", "no more emails", "do not contact"],
  no_interest: ["no me interesa", "no nos interesa", "no estamos interesados", "no estoy interesado", "not interested", "no thanks", "no gracias"],
  auto_reply: ["fuera de la oficina", "respuesta automatica", "out of office", "auto-reply", "autoreply", "automatic reply"],
  purchase: ["quiero comprar", "queremos comprar", "deseamos comprar", "orden de compra", "queremos contratar", "quiero contratar", "we want to buy", "purchase order", "place an order"],
  quote: ["cotizacion", "presupuesto", "cuanto cuesta", "cuanto vale", "lista de precios", "send a quote", "pricing", "how much"],
  call: ["llamame", "llamarme", "agendar una llamada", "agenda una llamada", "programar una llamada", "call me", "schedule a call", "book a call", "agendar una reunion"],
  info: ["mas informacion", "mayor informacion", "catalogo", "brochure", "more information", "send details", "send me details"],
  future: ["mas adelante", "el proximo ano", "en unos meses", "el proximo trimestre", "en el futuro", "later this year", "next quarter", "next year"],
};
const BLOCKING: IntentClass[] = ["unsubscribe", "no_interest", "auto_reply"];
const POSITIVE: IntentClass[] = ["purchase", "quote", "call", "info", "future"];
const NEGATIONS = ["no ", "not ", "sin ", "nunca ", "ni ", "tampoco "];

export const fold = (s: string): string => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

export type Classification = { class: IntentClass; ambiguous: boolean; matched: Array<{ class: string; phrase: string }>; version: string };

/**
 * Explicit, explainable rules (no model):
 * 1. unsubscribe > no_interest > auto_reply always win (a removal request prevails over anything else);
 * 2. otherwise the positive class with most phrase hits; a tie between classes, or a negation right before a hit, is AMBIGUOUS -> "review" (a human decides);
 * 3. nothing matched -> "review" (never silently "irrelevant").
 */
export function classify(text: string): Classification {
  const t = ` ${fold(text)} `;
  const hits: Array<{ class: IntentClass; phrase: string; negated: boolean }> = [];
  for (const [cls, phrases] of Object.entries(DICTIONARY) as Array<[IntentClass, string[]]>) {
    for (const phrase of phrases) {
      const at = t.indexOf(` ${phrase}`) >= 0 ? t.indexOf(` ${phrase}`) + 1 : t.indexOf(phrase);
      if (at < 0) continue;
      const before = t.slice(Math.max(0, at - 14), at);
      hits.push({ class: cls, phrase, negated: NEGATIONS.some((n) => before.endsWith(n) || before.includes(` ${n}`)) });
    }
  }
  const matched = hits.map((h) => ({ class: h.class, phrase: h.phrase }));
  for (const blocker of BLOCKING) {
    if (hits.some((h) => h.class === blocker && !(blocker !== "unsubscribe" && h.negated))) return { class: blocker, ambiguous: false, matched, version: CLASSIFIER_VERSION };
  }
  const positive = hits.filter((h) => POSITIVE.includes(h.class));
  if (positive.length === 0) return { class: "review", ambiguous: false, matched, version: CLASSIFIER_VERSION };
  if (positive.some((h) => h.negated)) return { class: "review", ambiguous: true, matched, version: CLASSIFIER_VERSION };
  const counts = new Map<IntentClass, number>();
  for (const h of positive) counts.set(h.class, (counts.get(h.class) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0] as [IntentClass, number];
  if (ranked[1] && ranked[1][1] === top[1]) return { class: "review", ambiguous: true, matched, version: CLASSIFIER_VERSION };
  return { class: top[0], ambiguous: false, matched, version: CLASSIFIER_VERSION };
}
