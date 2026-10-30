import { notice } from "../../lib/notices";

/** One-line result of the last action (from ?ok= / ?error= codes; text comes from a fixed vocabulary, never from the URL). */
export function Flash({ sp }: { sp: { ok?: string; error?: string } }) {
  const n = notice(sp);
  if (!n) return null;
  return n.kind === "error" ? <p role="alert" className="notice error">{n.text}</p> : <p role="status" className="notice ok">{n.text}</p>;
}
