import { Inject, Injectable } from "@nestjs/common";
import type { EmailSettingsDto, EmailSettingsTestDto, TestEmailSettingsRequest, UpdateEmailSettingsRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { loadSecurityConfig } from "../config/security.config.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import { ApiException } from "../http/api-exception.js";
import { SmtpEmailAdapter, classifySmtpError, openSecret, sealSecret, verifySmtp, type SmtpAccount } from "./smtp.js";

type Row = { host: string; port: number; secure: boolean; username: string; password_enc: string; from_name: string | null; from_email: string; reply_to: string | null; verified_at: Date | null; updated_at: Date };
const EMPTY: EmailSettingsDto = { configured: false, host: null, port: null, secure: null, username: null, hasPassword: false, fromName: null, fromEmail: null, replyTo: null, verifiedAt: null, updatedAt: null };
const dto = (r: Row): EmailSettingsDto => ({
  configured: true, host: r.host, port: r.port, secure: r.secure, username: r.username, hasPassword: true, fromName: r.from_name, fromEmail: r.from_email, replyTo: r.reply_to,
  verifiedAt: r.verified_at?.toISOString() ?? null, updatedAt: r.updated_at.toISOString(),
});
const aad = (organizationId: string) => `email_settings:${organizationId}`;

@Injectable()
export class EmailSettingsService {
  private readonly config = loadSecurityConfig();

  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  get(auth: AuthContext): Promise<EmailSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const row = await tx.emailSettings.findFirst({ where: { organization_id: auth.organizationId } });
      return row ? dto(row) : EMPTY;
    });
  }

  replace(auth: AuthContext, input: UpdateEmailSettingsRequest): Promise<EmailSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const before = await tx.emailSettings.findFirst({ where: { organization_id: auth.organizationId } });
      // A stored password is only reused for the same server and login: otherwise changing the host would hand it to another machine.
      if (input.password === undefined && (!before || before.host !== input.host || before.username !== input.username || before.port !== input.port)) {
        throw new ApiException(400, "VALIDATION_FAILED", "The password is required when the server, port or user changes");
      }
      const data = {
        host: input.host, port: input.port, secure: input.secure, username: input.username,
        password_enc: input.password === undefined ? (before as Row).password_enc : sealSecret(this.config.encryptionKey, input.password, aad(auth.organizationId)),
        from_name: input.fromName ?? null, from_email: input.fromEmail, reply_to: input.replyTo ?? null, verified_at: null,
      };
      const row = await tx.emailSettings.upsert({ where: { organization_id: auth.organizationId }, create: { organization_id: auth.organizationId, ...data }, update: data });
      // Audit says which fields changed, never their values; the password is only "changed" or not.
      const changed = (["host", "port", "secure", "username", "from_name", "from_email", "reply_to"] as const).filter((k) => (before?.[k] ?? null) !== data[k]);
      await this.audit.record(tx, auth, { action: "email_settings.updated", resourceType: "organization", resourceId: auth.organizationId, metadata: { changedFields: changed, passwordChanged: input.password !== undefined } });
      return dto(row);
    });
  }

  remove(auth: AuthContext): Promise<EmailSettingsDto> {
    return this.db.withTenant(auth, async (tx) => {
      const { count } = await tx.emailSettings.deleteMany({ where: { organization_id: auth.organizationId } });
      if (count > 0) await this.audit.record(tx, auth, { action: "email_settings.deleted", resourceType: "organization", resourceId: auth.organizationId });
      return EMPTY;
    });
  }

  /** The network call happens outside any transaction. Failures come back as a category: provider text may echo credentials or addresses. */
  async test(auth: AuthContext, input: TestEmailSettingsRequest): Promise<EmailSettingsTestDto> {
    const account = await this.db.withTenant(auth, (tx) => this.account(tx, auth.organizationId));
    if (!account) throw new ApiException(409, "CONFLICT", "No SMTP account is configured");
    let sent = false;
    try {
      await verifySmtp(account);
      if (input.sendTo) {
        await new SmtpEmailAdapter(account).send({ idempotencyKey: `smtp-test:${auth.organizationId}:${Date.now()}`, to: input.sendTo, subject: "Prueba de configuración de correo", body: "Este es un mensaje de prueba de la configuración SMTP de su organización. No requiere respuesta." });
        sent = true;
      }
    } catch (e) {
      const failure = classifySmtpError(e);
      await this.db.withTenant(auth, (tx) => this.audit.record(tx, auth, { action: "email_settings.test_failed", resourceType: "organization", resourceId: auth.organizationId, metadata: { failure } }));
      return { ok: false, sent: false, failure, verifiedAt: null };
    }
    const verifiedAt = new Date();
    await this.db.withTenant(auth, async (tx) => {
      await tx.emailSettings.updateMany({ where: { organization_id: auth.organizationId }, data: { verified_at: verifiedAt } });
      await this.audit.record(tx, auth, { action: "email_settings.verified", resourceType: "organization", resourceId: auth.organizationId, metadata: { sent } });
    });
    return { ok: true, sent, failure: null, verifiedAt: verifiedAt.toISOString() };
  }

  /** Decrypted account for the sender (worker). Null when the organization has not configured one. */
  async account(tx: Tx, organizationId: string): Promise<SmtpAccount | null> {
    const row = await tx.emailSettings.findFirst({ where: { organization_id: organizationId } });
    if (!row) return null;
    let password: string;
    try {
      password = openSecret(this.config.encryptionKey, row.password_enc, aad(organizationId));
    } catch {
      throw new ApiException(503, "UNAVAILABLE", "The stored SMTP password cannot be read; save the email settings again");
    }
    return { host: row.host, port: row.port, secure: row.secure, username: row.username, password, fromName: row.from_name, fromEmail: row.from_email, replyTo: row.reply_to };
  }
}
