import { randomBytes, randomUUID } from "node:crypto";
import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { LoginRequest, MeDto, MembershipRole, MyOrganizationsDto, RegisterRequest, SessionDto } from "@prospecting/contracts";
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

  async logout(auth: AuthContext): Promise<void> {
    await this.db.withTenant(auth, async (tx) => {
      await tx.session.updateMany({ where: { id: auth.sessionId, organization_id: auth.organizationId }, data: { revoked_at: new Date() } });
      await this.audit.record(tx, auth, { action: "auth.logout", resourceType: "session", resourceId: auth.sessionId });
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
