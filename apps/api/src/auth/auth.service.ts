import { randomBytes, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { ChangePasswordRequest, ChangedPasswordDto, CreateOrganizationRequest, LoginRequest, MeDto, SessionInfoListDto, MembershipRole, MyOrganizationsDto, RegisterRequest, SessionDto } from "@prospecting/contracts";
import { ROLE_PERMISSIONS } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import { PrismaService, type Tx } from "../db/prisma.service.js";
import type { AuthContext } from "./auth.types.js";
import { ApiException } from "../http/api-exception.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "./password.js";
import { LoginThrottleService } from "./login-throttle.service.js";
import { newSessionToken, SESSION_TTL_MS } from "./tokens.js";

type UserRow = { id: string; password_hash: string; status: "active" | "disabled" };
type MembershipRow = { organization_id: string; slug: string; role: MembershipRole };

const UNIQUE_VIOLATION = "P2002";
const MAX_ADMIN_ORGANIZATIONS = 20;

function slugify(name: string): string {
  const base = name.normalize("NFKD").replace(/\P{ASCII}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return `${base || "org"}-${randomBytes(3).toString("hex")}`;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LoginThrottleService) private readonly throttle: LoginThrottleService,
  ) {}

  /** Creates user + organization + org_admin membership + session atomically. Ids are server-generated; the tenant context is the new org. */
  async register(input: RegisterRequest, requestId: string): Promise<SessionDto> {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const ctx = { organizationId, userId, role: "org_admin" as const };
    try {
      return await this.db.withTenant(ctx, async (tx) => {
        await tx.user.create({
          data: { id: userId, email: input.email, password_hash: passwordHash, display_name: input.displayName },
          select: { id: true },
        });
        const org = await tx.organization.create({
          data: { id: organizationId, name: input.organizationName, slug: slugify(input.organizationName) },
          select: { id: true, name: true, slug: true },
        });
        const membership = await tx.membership.create({
          data: { organization_id: organizationId, user_id: userId, role: "org_admin" },
          select: { id: true },
        });
        const actor = { organizationId, userId, requestId };
        await this.audit.record(tx, actor, { action: "organization.created", resourceType: "organization", resourceId: organizationId });
        await this.audit.record(tx, actor, { action: "membership.created", resourceType: "membership", resourceId: membership.id, metadata: { role: "org_admin" } });
        return this.openSession(tx, actor, { organization: org, role: "org_admin" });
      });
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new ConflictException("Unable to register with the provided data");
      throw e;
    }
  }

  async login(input: LoginRequest, requestId: string, clientIp: string): Promise<SessionDto> {
    const attempt = await this.throttle.begin(clientIp, input.email);
    const { user, memberships } = await this.db.withoutTenant(async (tx) => {
      const users = await tx.$queryRaw<UserRow[]>`SELECT * FROM auth_lookup_user(${input.email})`;
      const found = users[0];
      const list = found ? await tx.$queryRaw<MembershipRow[]>`SELECT * FROM auth_list_memberships(${found.id}::uuid)` : [];
      return { user: found, memberships: list };
    });

    const passwordOk = await verifyPassword(input.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !passwordOk || user.status !== "active") throw new UnauthorizedException("Invalid credentials");

    // The slug is only a hint: it must match one of the user's own verified memberships.
    const chosen = input.organizationSlug ? memberships.find((m) => m.slug === input.organizationSlug) : memberships[0];
    if (!chosen) throw new ForbiddenException("No active organization membership");

    const ctx = { organizationId: chosen.organization_id, userId: user.id, role: chosen.role };
    const session = await this.db.withTenant(ctx, async (tx) => {
      const org = await tx.organization.findFirstOrThrow({ where: { id: chosen.organization_id }, select: { id: true, name: true, slug: true } });
      const actor = { organizationId: chosen.organization_id, userId: user.id, requestId };
      await this.audit.record(tx, actor, { action: "auth.login", resourceType: "session" });
      return this.openSession(tx, actor, { organization: org, role: chosen.role });
    });
    await this.throttle.succeeded(attempt.attemptId, attempt.accountHash);
    return session;
  }

  /**
   * Issues a session for another organization. The slug is only a hint: it must match one of the user's own active memberships
   * (re-read from the database, not from the old session), otherwise 404 - identical for nonexistent and foreign organizations.
   */
  async switchOrganization(auth: AuthContext, slug: string): Promise<SessionDto> {
    const memberships = await this.db.withoutTenant((tx) => tx.$queryRaw<MembershipRow[]>`SELECT * FROM auth_list_memberships(${auth.userId}::uuid)`);
    const chosen = memberships.find((m) => m.slug === slug);
    if (!chosen) throw new ApiException(404, "NOT_FOUND", "Organization not found");

    const ctx = { organizationId: chosen.organization_id, userId: auth.userId, role: chosen.role };
    const session = await this.db.withTenant(ctx, async (tx) => {
      const org = await tx.organization.findFirstOrThrow({ where: { id: chosen.organization_id }, select: { id: true, name: true, slug: true } });
      const actor = { organizationId: chosen.organization_id, userId: auth.userId, requestId: auth.requestId };
      await this.audit.record(tx, actor, {
        action: "auth.organization_switched",
        resourceType: "session",
        metadata: { fromOrganizationId: auth.organizationId },
      });
      return this.openSession(tx, actor, { organization: org, role: chosen.role });
    });
    await this.logout(auth); // revoke the previous session (audited in its own organization)
    return session;
  }

  /**
   * An authenticated user creates another organization and becomes its org_admin. The new session is opened in it and the previous
   * one is revoked (same as switchOrganization). Abuse limit: at most MAX_ADMIN_ORGANIZATIONS organizations administered per user.
   */
  async createOrganization(auth: AuthContext, input: CreateOrganizationRequest): Promise<SessionDto> {
    const mine = await this.db.withoutTenant((tx) => tx.$queryRaw<Array<{ name: string; role: MembershipRole }>>`SELECT * FROM auth_list_my_organizations(${auth.userId}::uuid)`);
    if (mine.filter((m) => m.role === "org_admin").length >= MAX_ADMIN_ORGANIZATIONS) {
      throw new ApiException(409, "CONFLICT", `Organization limit reached (${MAX_ADMIN_ORGANIZATIONS} administered organizations)`);
    }
    // Names are not globally unique (RLS hides other tenants and there is no unique index); a repeat within the caller's own organizations is refused.
    if (mine.some((m) => m.name.trim().toLowerCase() === input.organizationName.toLowerCase())) {
      throw new ApiException(409, "CONFLICT", "You already have an organization with that name");
    }
    const organizationId = randomUUID();
    const ctx = { organizationId, userId: auth.userId, role: "org_admin" as const };
    let session: SessionDto;
    try {
      session = await this.db.withTenant(ctx, async (tx) => {
        const org = await tx.organization.create({
          data: { id: organizationId, name: input.organizationName, slug: slugify(input.organizationName) },
          select: { id: true, name: true, slug: true },
        });
        const membership = await tx.membership.create({
          data: { organization_id: organizationId, user_id: auth.userId, role: "org_admin" },
          select: { id: true },
        });
        const actor = { organizationId, userId: auth.userId, requestId: auth.requestId };
        await this.audit.record(tx, actor, { action: "organization.created", resourceType: "organization", resourceId: organizationId });
        await this.audit.record(tx, actor, { action: "membership.created", resourceType: "membership", resourceId: membership.id, metadata: { role: "org_admin" } });
        return this.openSession(tx, actor, { organization: org, role: "org_admin" });
      });
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new ApiException(409, "CONFLICT", "An organization with that name already exists");
      throw e;
    }
    await this.logout(auth); // revoke the previous session (audited in its own organization)
    return session;
  }

  async logout(auth: AuthContext): Promise<void> {
    await this.db.withTenant(auth, async (tx) => {
      await tx.session.updateMany({ where: { id: auth.sessionId, organization_id: auth.organizationId }, data: { revoked_at: new Date() } });
      await this.audit.record(tx, auth, { action: "auth.logout", resourceType: "session", resourceId: auth.sessionId });
    });
  }

  /**
   * Verifies the current password (hash read only through the SECURITY DEFINER lookup), shares the login throttle so a stolen session
   * cannot be used to guess the password, then rotates the hash and revokes every other session of the user in all organizations.
   */
  async changePassword(auth: AuthContext, input: ChangePasswordRequest, clientIp: string): Promise<ChangedPasswordDto> {
    const email = await this.db.withTenant(auth, async (tx) => (await tx.user.findFirstOrThrow({ where: { id: auth.userId }, select: { email: true } })).email);
    const attempt = await this.throttle.begin(clientIp, email);
    const user = await this.db.withoutTenant(async (tx) => (await tx.$queryRaw<UserRow[]>`SELECT * FROM auth_lookup_user(${email})`)[0]);
    const ok = await verifyPassword(input.currentPassword, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) throw new ApiException(403, "FORBIDDEN", "The current password is not correct");
    const newHash = await hashPassword(input.newPassword);
    const revoked = await this.db.withTenant(auth, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ n: number }>>`SELECT auth_change_password(${auth.userId}::uuid, ${newHash}, ${auth.sessionId}::uuid) AS n`;
      const n = Number(rows[0]?.n ?? 0);
      await this.audit.record(tx, auth, { action: "auth.password_changed", resourceType: "user", resourceId: auth.userId, metadata: { revokedSessions: n } });
      return n;
    });
    await this.throttle.succeeded(attempt.attemptId, attempt.accountHash);
    return { revokedSessions: revoked };
  }

  async mySessions(auth: AuthContext): Promise<SessionInfoListDto> {
    const rows = await this.db.withTenant(auth, (tx) =>
      tx.session.findMany({
        where: { organization_id: auth.organizationId, user_id: auth.userId, revoked_at: null, expires_at: { gt: new Date() } },
        orderBy: { created_at: "desc" },
        select: { id: true, created_at: true, expires_at: true },
      }),
    );
    return { items: rows.map((r) => ({ id: r.id, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString(), current: r.id === auth.sessionId })) };
  }

  async revokeMySession(auth: AuthContext, sessionId: string): Promise<void> {
    if (sessionId === auth.sessionId) throw new ApiException(409, "CONFLICT", "Use logout to end the current session");
    await this.db.withTenant(auth, async (tx) => {
      const res = await tx.session.updateMany({ where: { id: sessionId, organization_id: auth.organizationId, user_id: auth.userId, revoked_at: null }, data: { revoked_at: new Date() } });
      if (res.count === 0) throw new ApiException(404, "NOT_FOUND", "Session not found");
      await this.audit.record(tx, auth, { action: "auth.session_revoked", resourceType: "session", resourceId: sessionId });
    });
  }

  async myOrganizations(auth: AuthContext): Promise<MyOrganizationsDto> {
    const rows = await this.db.withoutTenant((tx) => tx.$queryRaw<Array<{ organization_id: string; name: string; slug: string; role: MembershipRole }>>`SELECT * FROM auth_list_my_organizations(${auth.userId}::uuid)`);
    return { items: rows.map((r) => ({ id: r.organization_id, name: r.name, slug: r.slug, role: r.role, current: r.organization_id === auth.organizationId })) };
  }

  me(auth: AuthContext): Promise<MeDto> {
    return this.db.withTenant(auth, async (tx) => {
      const [user, org] = await Promise.all([
        tx.user.findFirstOrThrow({ where: { id: auth.userId }, select: { id: true, email: true, display_name: true } }),
        tx.organization.findFirstOrThrow({ where: { id: auth.organizationId }, select: { id: true, name: true, slug: true } }),
      ]);
      return {
        user: { id: user.id, email: user.email, displayName: user.display_name },
        organization: org,
        role: auth.role,
        permissions: ROLE_PERMISSIONS[auth.role],
      };
    });
  }

  private async openSession(
    tx: Tx,
    actor: { organizationId: string; userId: string },
    info: { organization: { id: string; name: string; slug: string }; role: MembershipRole },
  ): Promise<SessionDto> {
    const { token, tokenHash } = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await tx.session.create({
      data: { organization_id: actor.organizationId, user_id: actor.userId, token_hash: tokenHash, expires_at: expiresAt },
      select: { id: true },
    });
    return { token, expiresAt: expiresAt.toISOString(), organization: info.organization, role: info.role };
  }
}
