import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MembershipRole } from "@prospecting/contracts";
import { type Api, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P4/P5: reversible, non-destructive duplicate merge (link only; no child row moves), with database-enforced invariants. */
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
const prospect = async (t: string, name: string) =>
  (await api.call("POST", "/prospects", { token: t, body: { name: `${name} ${randomUUID().slice(0, 6)}`, domain: `m-${randomUUID().slice(0, 8)}.example` } })).body.id as string;
const merge = (t: string, survivor: string, duplicateId: string, reason = "misma empresa") => api.call("POST", `/prospects/${survivor}/merge`, { token: t, body: { duplicateId, reason } });
const ids = async (t: string) => ((await api.call("GET", "/prospects?limit=100", { token: t })).body.items as Array<{ id: string }>).map((p) => p.id);

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("merging duplicates", () => {
  it("hides the duplicate in lists and exports, keeps it readable, forbids chains/self/double merges, and is fully reversible", async () => {
    const a = await register("merge");
    const [p1, p2, p3] = [await prospect(a.token, "Acme"), await prospect(a.token, "ACME SA"), await prospect(a.token, "Otra")];

    const m = await merge(a.token, p1, p2);
    expect(m.status).toBe(201);
    expect(m.body).toMatchObject({ survivorId: p1, duplicateId: p2, reason: "misma empresa", mergedBy: a.userId, revertedAt: null, revertedBy: null });

    const listed = await ids(a.token);
    expect(listed).toContain(p1);
    expect(listed).toContain(p3);
    expect(listed).not.toContain(p2); // hidden
    expect((await api.call("GET", `/prospects/${p2}`, { token: a.token })).status).toBe(200); // still readable (nothing was deleted)
    const csv = await fetch(`${await api.app.getUrl()}/v1/prospects/export`, { headers: { authorization: `Bearer ${a.token}` } }).then((r) => r.text());
    expect(csv).toContain(p1);
    expect(csv).not.toContain(p2);

    expect((await merge(a.token, p1, p1)).status).toBe(400); // into itself
    expect((await merge(a.token, p3, p2)).status).toBe(409); // p2 is already merged
    expect((await merge(a.token, p3, p1)).status).toBe(409); // p1 is a survivor: no chains
    expect((await merge(a.token, p2, p3)).status).toBe(409); // p2 is a hidden duplicate: it cannot be a survivor
    expect((await merge(a.token, p1, randomUUID())).status).toBe(404);

    for (const pid of [p1, p2]) {
      const h = await api.call("GET", `/prospects/${pid}/merges`, { token: a.token });
      expect(h.status).toBe(200);
      expect(h.body.items).toHaveLength(1);
    }

    const mergeId = m.body.id as string;
    expect((await api.call("POST", `/prospects/${p3}/merges/${mergeId}/revert`, { token: a.token })).status).toBe(404); // wrong survivor
    const reverted = await api.call("POST", `/prospects/${p1}/merges/${mergeId}/revert`, { token: a.token });
    expect(reverted.status).toBe(200);
    expect(reverted.body).toMatchObject({ revertedBy: a.userId });
    expect(reverted.body.revertedAt).not.toBeNull();
    expect(await ids(a.token)).toContain(p2); // reappears unchanged
    expect((await api.call("POST", `/prospects/${p1}/merges/${mergeId}/revert`, { token: a.token })).status).toBe(409);

    expect((await merge(a.token, p3, p2)).status).toBe(201); // a new merge is allowed after reverting
    const history = await api.call("GET", `/prospects/${p2}/merges`, { token: a.token });
    expect(history.body.items).toHaveLength(2);

    const audit = await owner.query("SELECT action FROM audit_events WHERE organization_id = $1 AND action LIKE 'prospect.merge%' ORDER BY created_at", [a.orgId]);
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual(["prospect.merged", "prospect.merge_reverted", "prospect.merged"]);
  });

  it("the database refuses edits other than a single revert, and chains/duplicates on direct SQL", async () => {
    const a = await register("merge-db");
    const [p1, p2, p3] = [await prospect(a.token, "A"), await prospect(a.token, "B"), await prospect(a.token, "C")];
    const mergeId = (await merge(a.token, p1, p2)).body.id as string;
    await expect(owner.query("UPDATE prospect_merges SET reason = 'cambio' WHERE id = $1", [mergeId])).rejects.toThrow(/can only be reverted/);
    await expect(
      owner.query("INSERT INTO prospect_merges (organization_id, survivor_id, duplicate_id, reason, merged_by) VALUES ($1, $2, $3, 'x', $4)", [a.orgId, p3, p2, a.userId]),
    ).rejects.toThrow(/already merged/);
    await expect(
      owner.query("INSERT INTO prospect_merges (organization_id, survivor_id, duplicate_id, reason, merged_by) VALUES ($1, $2, $3, 'x', $4)", [a.orgId, p3, p1, a.userId]),
    ).rejects.toThrow(/merge chains/);
  });

  it("is invisible across tenants, and needs prospects:manage (viewers read-only)", async () => {
    const a = await register("merge-t1");
    const b = await register("merge-t2");
    const [p1, p2] = [await prospect(a.token, "X"), await prospect(a.token, "Y")];
    const mergeId = (await merge(a.token, p1, p2)).body.id as string;

    expect((await merge(b.token, p1, p2)).status).toBe(404);
    expect((await api.call("GET", `/prospects/${p1}/merges`, { token: b.token })).status).toBe(404);
    expect((await api.call("POST", `/prospects/${p1}/merges/${mergeId}/revert`, { token: b.token })).status).toBe(404);

    const viewer = await member(a.orgId, "viewer");
    expect((await api.call("GET", `/prospects/${p1}/merges`, { token: viewer })).status).toBe(200);
    expect((await merge(viewer, p1, p2)).status).toBe(403);
    expect((await api.call("POST", `/prospects/${p1}/merges/${mergeId}/revert`, { token: viewer })).status).toBe(403);
    expect((await api.call("POST", `/prospects/${p1}/merge`, { body: { duplicateId: p2, reason: "x" } })).status).toBe(401);
    expect((await api.call("POST", `/prospects/${p1}/merge`, { token: a.token, body: { duplicateId: "no-uuid", reason: "x" } })).status).toBe(400);
  });
});
