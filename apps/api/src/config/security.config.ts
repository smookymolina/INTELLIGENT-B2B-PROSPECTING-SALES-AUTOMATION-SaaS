/** Server secrets. Validated once at startup (fail fast); never logged. */
export type SecurityConfig = Readonly<{ hmacSecret: string; encryptionKey: Buffer }>;

export function loadSecurityConfig(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const hmacSecret = env.HMAC_SECRET ?? "";
  if (hmacSecret.length < 32) throw new Error("HMAC_SECRET must be set to at least 32 characters");
  const encryptionKey = Buffer.from(env.ENCRYPTION_KEY ?? "", "base64");
  if (encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return { hmacSecret, encryptionKey };
}
