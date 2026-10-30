import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { MembershipRole } from "@prospecting/contracts";
import { PrismaService } from "../db/prisma.service.js";
import type { AppRequest } from "./auth.types.js";
import { IS_PUBLIC } from "./decorators.js";
import { hashToken } from "./tokens.js";

type SessionRow = { session_id: string; user_id: string; organization_id: string; role: MembershipRole };

/** Resolves the Bearer session. The tenant (organization) comes from the session row, never from the client request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PrismaService) private readonly db: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const requestId = req.requestId ?? "unknown"; // set by the requestId middleware
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) return true;

    const match = /^Bearer ([A-Za-z0-9_-]{20,128})$/.exec(req.headers.authorization ?? "");
    if (!match?.[1]) throw new UnauthorizedException();
    const tokenHash = hashToken(match[1]);

    const rows = await this.db.withoutTenant((tx) => tx.$queryRaw<SessionRow[]>`SELECT * FROM auth_resolve_session(${tokenHash})`);
    const row = rows[0];
    if (!row) throw new UnauthorizedException();
    req.auth = { sessionId: row.session_id, userId: row.user_id, organizationId: row.organization_id, role: row.role, requestId };
    return true;
  }
}
