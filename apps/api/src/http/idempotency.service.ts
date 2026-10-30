import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { loadSecurityConfig } from "../config/security.config.js";
import { PrismaService } from "../db/prisma.service.js";
import { ApiException } from "./api-exception.js";

type BeginRow = { state: "new" | "replay" | "conflict" | "in_progress"; response_ciphertext: string | null };

/**
 * `Idempotency-Key` support. First request claims (scope,key) atomically in PostgreSQL, runs the command and stores its JSON result
 * encrypted (AES-256-GCM, bound to the key hash) for 24 h; same key + same request replays it; same key + different request -> 422;
 * concurrent duplicate -> 409. Failed commands release the claim. Keys, request fingerprints and results are never stored in clear.
 */
@Injectable()
export class IdempotencyService {
  private readonly config = loadSecurityConfig();
  private readonly logger = new Logger("Idempotency");

  constructor(@Inject(PrismaService) private readonly db: PrismaService) {}

  async run<T>(
    input: { scope: string; key: string | undefined; fingerprint: unknown },
    command: () => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    if (!input.key) return { value: await command(), replayed: false };

    const keyHash = this.hmac(`key:${input.scope}:${input.key}`);
    const requestHash = this.hmac(`req:${JSON.stringify(input.fingerprint)}`);
    const rows = await this.db.withoutTenant(
      (tx) => tx.$queryRaw<BeginRow[]>`SELECT * FROM idem_begin(${input.scope}, ${keyHash}, ${requestHash})`,
    );
    const begin = rows[0];

    if (begin?.state === "conflict") {
      throw new ApiException(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request");
    }
    if (begin?.state === "in_progress" || !begin) {
      throw new ApiException(409, "IDEMPOTENCY_IN_PROGRESS", "A request with this Idempotency-Key is still being processed", null, { "Retry-After": "1" });
    }
    if (begin.state === "replay" && begin.response_ciphertext) {
      return { value: JSON.parse(this.decrypt(begin.response_ciphertext, keyHash)) as T, replayed: true };
    }

    let value: T;
    try {
      value = await command();
    } catch (error) {
      await this.db.withoutTenant((tx) => tx.$executeRaw`SELECT idem_release(${input.scope}, ${keyHash})`).catch(() => undefined);
      throw error;
    }
    try {
      const ciphertext = this.encrypt(JSON.stringify(value), keyHash);
      await this.db.withoutTenant((tx) => tx.$executeRaw`SELECT idem_complete(${input.scope}, ${keyHash}, ${ciphertext})`);
    } catch {
      // The command succeeded; an unfinished claim expires on its own (5 min) and the client sees 409 until then rather than a duplicate.
      this.logger.error("failed to store idempotent result");
    }
    return { value, replayed: false };
  }

  private hmac(data: string): string {
    return createHmac("sha256", this.config.hmacSecret).update(data).digest("hex");
  }

  private encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.config.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
  }

  private decrypt(stored: string, aad: string): string {
    const [version, iv, tag, body] = stored.split(".");
    if (version !== "v1" || !iv || !tag || !body) throw new Error("unsupported ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.config.encryptionKey, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  }
}
