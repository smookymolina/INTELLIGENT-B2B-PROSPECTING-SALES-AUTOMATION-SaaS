import { z } from "zod";

export const MCP_TOOLS = ["get_outreach_context", "save_message_draft", "get_draft_status"] as const;
export const ReportMcpUsageRequest = z.strictObject({ tool: z.enum(MCP_TOOLS), outcome: z.enum(["ok", "error"]) });
export type ReportMcpUsageRequest = z.infer<typeof ReportMcpUsageRequest>;
export const SetMcpLimitRequest = z.strictObject({ monthlyLimit: z.number().int().min(0).max(100_000_000) });
export type SetMcpLimitRequest = z.infer<typeof SetMcpLimitRequest>;

export const CLAUDE_PLAN_NOTICE = "El porcentaje de tu plan Claude Pro no es visible para el SaaS";
export const AiUsageSummaryDto = z.object({
  period: z.object({ from: z.iso.datetime(), to: z.iso.datetime() }),
  claudePlanNotice: z.literal(CLAUDE_PLAN_NOTICE),
  mcp: z.object({
    monthlyLimit: z.number().int(), // 0 = no internal limit
    calls: z.number().int(),
    percentUsed: z.number().nullable(), // null when there is no limit
    byTool: z.array(z.object({ tool: z.string(), calls: z.number().int(), errors: z.number().int() })),
    byUser: z.array(z.object({ userId: z.uuid(), calls: z.number().int() })),
    daily: z.array(z.object({ date: z.string(), calls: z.number().int() })),
  }),
  api: z.object({
    monthlyLimitMicros: z.number().nullable(),
    spentMicros: z.number(),
    percentUsed: z.number().nullable(),
    runs: z.number().int(),
  }),
});
export type AiUsageSummaryDto = z.infer<typeof AiUsageSummaryDto>;
