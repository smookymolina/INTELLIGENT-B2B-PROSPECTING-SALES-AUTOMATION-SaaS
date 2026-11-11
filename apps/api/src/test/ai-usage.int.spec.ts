import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiUsageSummaryDto, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** "Uso de Claude": MCP call metering (metadata only), internal monthly limit, and the API-adapter ledger percentage. */
let api: Api;
type Account = { token: string; orgId: string; userId: string };

async function register(label: string): Promise<Account> {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.test`;
  const res = await api.call("POST", "/auth/register", { body: { email, password: PASSWORD, displayName: label, organizationName: `Org ${label}` } });
  const me = await api.call("GET", "/me", { token: res.body.token });
  return { token: res.body.token, orgId: res.body.organization.id, userId: me.body.user.id };
}
async function member(orgId: string, role: MembershipRole) {
  const m = await seedMember(orgId, role);
  return (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
}
const report = (t: string, tool: string, outcome = "ok") => api.call("POST", "/ai/mcp-usage", { token: t, body: { tool, outcome } });
const summary = (t: string) => api.call("GET", "/ai/usage-summary", { token: t });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("MCP usage summary", () => {
  it("counts calls per tool/user/day and reports percent against the internal limit", async () => {
    const a = await register("mcp-a");
    expect((await report(a.token, "get_outreach_context")).status).toBe(204);
    await report(a.token, "get_outreach_context");
    await report(a.token, "save_message_draft", "error");
    const s0 = await summary(a.token);
    expect(s0.status).toBe(200);
    const d = AiUsageSummaryDto.parse(s0.body);
    expect(d.mcp.calls).toBe(3);
    expect(d.mcp.monthlyLimit).toBe(0);
    expect(d.mcp.percentUsed).toBeNull(); // 0 = no limit
    expect(d.mcp.byTool).toEqual([{ tool: "get_outreach_context", calls: 2, errors: 0 }, { tool: "save_message_draft", calls: 1, errors: 1 }]);
    expect(d.mcp.byUser).toEqual([{ userId: a.userId, calls: 3 }]);
    expect(d.mcp.daily).toHaveLength(1);
    expect(d.mcp.daily[0]?.calls).toBe(3);
    expect(d.claudePlanNotice).toContain("no es visible para el SaaS");

    const set = await api.call("PUT", "/ai/mcp-limit", { token: a.token, body: { monthlyLimit: 12 } });
    expect(set.status).toBe(200);
    expect(set.body.mcp.percentUsed).toBe(25);
    expect((await api.call("PUT", "/ai/mcp-limit", { token: a.token, body: { monthlyLimit: 0 } })).body.mcp.percentUsed).toBeNull();
    expect((await api.call("PUT", "/ai/mcp-limit", { token: a.token, body: { monthlyLimit: -1 } })).status).toBe(400);
  });

  it("shows the API ledger percentage against the monthly budget", async () => {
    const a = await register("mcp-api");
    expect((await summary(a.token)).body.api).toEqual({ monthlyLimitMicros: null, spentMicros: 0, percentUsed: null, runs: 0 });
    await api.call("PUT", "/ai/budget", { token: a.token, body: { monthlyLimitMicros: 1000 } });
    await owner.query(
      `INSERT INTO ai_runs (organization_id, user_id, capability, prompt_key, prompt_version, provider, model, status, input_tokens, output_tokens, cost_micros, latency_ms, evidence_refs, flags, request_id)
       VALUES ($1, $2, 'offer_brief', 'k', 1, 'mock', 'm', 'ok', 1, 1, 250, 1, '{}', '{}', 'req-usage')`,
      [a.orgId, a.userId],
    );
    const s = (await summary(a.token)).body;
    expect(s.api).toMatchObject({ monthlyLimitMicros: 1000, spentMicros: 250, percentUsed: 25, runs: 1 });
  });

  it("isolates tenants and ignores any forged org/user in the body", async () => {
    const a = await register("mcp-iso-a");
    const b = await register("mcp-iso-b");
    await report(a.token, "get_draft_status");
    expect((await summary(b.token)).body.mcp.calls).toBe(0);
    await api.call("PUT", "/ai/mcp-limit", { token: a.token, body: { monthlyLimit: 5 } });
    expect((await summary(b.token)).body.mcp.monthlyLimit).toBe(0);
    const forged = await api.call("POST", "/ai/mcp-usage", { token: b.token, body: { tool: "get_draft_status", outcome: "ok", organizationId: a.orgId } });
    expect(forged.status).toBe(400);
    // RLS: b cannot insert for a's org or read a's rows at the DB level
    await expect(asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("INSERT INTO mcp_usage_events (organization_id, user_id, tool, outcome) VALUES ($1, $2, 'get_draft_status', 'ok')", [a.orgId, b.userId]))).rejects.toThrow();
    const rows = await asRuntime({ organizationId: b.orgId, userId: b.userId, role: "org_admin" }, (c) => c.query("SELECT * FROM mcp_usage_events"));
    expect(rows.rowCount).toBe(0);
  });

  it("only org_admin can change the limit; viewers cannot even report usage", async () => {
    const a = await register("mcp-roles");
    for (const role of ["seller", "sales_manager", "campaign_manager"] as MembershipRole[]) {
      const t = await member(a.orgId, role);
      expect((await api.call("PUT", "/ai/mcp-limit", { token: t, body: { monthlyLimit: 99 } })).status).toBe(403);
    }
    const seller = await member(a.orgId, "seller");
    expect((await report(seller, "get_outreach_context")).status).toBe(204);
    expect((await summary(a.token)).body.mcp.monthlyLimit).toBe(0);
    const viewer = await member(a.orgId, "viewer");
    expect((await report(viewer, "get_outreach_context")).status).toBe(403);
    // DB-level: a non-admin role cannot write the limit even bypassing the API guard
    const sellerRow = await owner.query("SELECT user_id FROM memberships WHERE organization_id = $1 AND role = 'seller' LIMIT 1", [a.orgId]);
    await expect(asRuntime({ organizationId: a.orgId, userId: sellerRow.rows[0].user_id, role: "seller" }, (c) => c.query("INSERT INTO mcp_limits (organization_id, monthly_limit, updated_by) VALUES ($1, 1, $2)", [a.orgId, sellerRow.rows[0].user_id]))).rejects.toThrow();
  });

  it("stores only metadata: rejects unknown tools/extra fields and has no content columns", async () => {
    const a = await register("mcp-meta");
    expect((await api.call("POST", "/ai/mcp-usage", { token: a.token, body: { tool: "other_tool", outcome: "ok" } })).status).toBe(400);
    expect((await api.call("POST", "/ai/mcp-usage", { token: a.token, body: { tool: "save_message_draft", outcome: "ok", body: "secret text" } })).status).toBe(400);
    const cols = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_usage_events' ORDER BY column_name");
    expect(cols.rows.map((r) => r.column_name)).toEqual(["created_at", "id", "organization_id", "outcome", "tool", "user_id"]);
  });
});
