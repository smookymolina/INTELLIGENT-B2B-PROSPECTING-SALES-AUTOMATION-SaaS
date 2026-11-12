/**
 * Per-organization outbound email cap. Conservative defaults protect the reputation of a small business's shared SMTP mailbox.
 * Validated at call time (fail fast on a bad value); EMAIL_MAX_PER_HOUR must not exceed EMAIL_MAX_PER_DAY.
 */
export type EmailCapConfig = Readonly<{ maxPerHour: number; maxPerDay: number }>;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a positive integer`);
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadEmailCapConfig(env: NodeJS.ProcessEnv = process.env): EmailCapConfig {
  const maxPerHour = positiveInt(env, "EMAIL_MAX_PER_HOUR", 50);
  const maxPerDay = positiveInt(env, "EMAIL_MAX_PER_DAY", 200);
  if (maxPerHour > maxPerDay) throw new Error("EMAIL_MAX_PER_HOUR must not exceed EMAIL_MAX_PER_DAY");
  return { maxPerHour, maxPerDay };
}
