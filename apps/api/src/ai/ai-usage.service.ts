import { Inject, Injectable } from "@nestjs/common";
import { CLAUDE_PLAN_NOTICE, type AiUsageSummaryDto, type ReportMcpUsageRequest, type SetMcpLimitRequest } from "@prospecting/contracts";
import { AuditService } from "../audit/audit.service.js";
import type { AuthContext } from "../auth/auth.types.js";
import { PrismaService } from "../db/prisma.service.js";
import { currentPeriod } from "./ai.service.js";

const pct = (used: number, limit: number): number | null => (limit > 0 ? Math.round((used / limit) * 1000) / 10 : null);

/** MCP call metering (metadata only: tool, outcome, user, time) and the combined "Claude usage" summary. */
@Injectable()
export class AiUsageService {
  constructor(
    @Inject(PrismaService) private readonly db: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Org and user come from the authenticated token, never from the body, so a call cannot be attributed to another tenant. */
  async report(auth: AuthContext, input: ReportMcpUsageRequest): Promise<void> {
    await this.db.withTenant(auth, (tx) =>
      tx.$executeRaw`INSERT INTO mcp_usage_events (organization_id, user_id, tool, outcome) VALUES (${auth.organizationId}::uuid, ${auth.userId}::uuid, ${input.tool}, ${input.outcome})`,
    );
  }

  async setLimit(auth: AuthContext, input: SetMcpLimitRequest): Promise<AiUsageSummaryDto> {
    await this.db.withTenant(auth, async (tx) => {
      await tx.$executeRaw`INSERT INTO mcp_limits (organization_id, monthly_limit, updated_by) VALUES (${auth.organizationId}::uuid, ${input.monthlyLimit}, ${auth.userId}::uuid)
        ON CONFLICT (organization_id) DO UPDATE SET monthly_limit = EXCLUDED.monthly_limit, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await this.audit.record(tx, auth, { action: "ai.mcp_limit_set", resourceType: "mcp_limit", metadata: { monthlyLimit: input.monthlyLimit } });
    });
    return this.summary(auth);
  }

  summary(auth: AuthContext): Promise<AiUsageSummaryDto> {
    const { start, end } = currentPeriod();
    return this.db.withTenant(auth, async (tx) => {
      const [lim, tools, users, days, budget, runs] = await Promise.all([
        tx.$queryRaw<Array<{ monthly_limit: number }>>`SELECT monthly_limit FROM mcp_limits WHERE organization_id = ${auth.organizationId}::uuid`,
        tx.$queryRaw<Array<{ tool: string; calls: number; errors: number }>>`SELECT tool, count(*)::int AS calls, count(*) FILTER (WHERE outcome = 'error')::int AS errors FROM mcp_usage_events WHERE organization_id = ${auth.organizationId}::uuid AND created_at >= ${start} AND created_at < ${end} GROUP BY tool ORDER BY tool`,
        tx.$queryRaw<Array<{ user_id: string; calls: number }>>`SELECT user_id, count(*)::int AS calls FROM mcp_usage_events WHERE organization_id = ${auth.organizationId}::uuid AND created_at >= ${start} AND created_at < ${end} GROUP BY user_id ORDER BY calls DESC LIMIT 50`,
        tx.$queryRaw<Array<{ d: string; calls: number }>>`SELECT to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d, count(*)::int AS calls FROM mcp_usage_events WHERE organization_id = ${auth.organizationId}::uuid AND created_at >= ${start} AND created_at < ${end} GROUP BY 1 ORDER BY 1`,
        tx.aiBudget.findUnique({ where: { organization_id: auth.organizationId }, select: { monthly_limit_micros: true } }),
        tx.aiRun.aggregate({ where: { organization_id: auth.organizationId, created_at: { gte: start, lt: end } }, _sum: { cost_micros: true }, _count: { _all: true } }),
      ]);
      const limit = lim[0]?.monthly_limit ?? 0;
      const calls = tools.reduce((n, t) => n + t.calls, 0);
      const apiLimit = budget ? Number(budget.monthly_limit_micros) : null;
      const spent = Number(runs._sum.cost_micros ?? 0n);
      return {
        period: { from: start.toISOString(), to: end.toISOString() },
        claudePlanNotice: CLAUDE_PLAN_NOTICE,
        mcp: {
          monthlyLimit: limit, calls, percentUsed: pct(calls, limit),
          byTool: tools, byUser: users.map((u) => ({ userId: u.user_id, calls: u.calls })), daily: days.map((d) => ({ date: d.d, calls: d.calls })),
        },
        api: { monthlyLimitMicros: apiLimit, spentMicros: spent, percentUsed: apiLimit ? pct(spent, apiLimit) : null, runs: runs._count._all },
      } satisfies AiUsageSummaryDto;
    });
  }
}
