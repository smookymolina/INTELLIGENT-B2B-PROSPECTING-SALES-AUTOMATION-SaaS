import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, QuoteDetailDto, type MembershipRole } from "@prospecting/contracts";
import { type Api, asRuntime, owner, PASSWORD, seedMember, startApi } from "./harness.js";

/** P10-01: quotes from approved evidence only, exact decimals (cross-checked by PostgreSQL), discount approval, frozen once sent, sales link. */
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
  const token = (await api.call("POST", "/auth/login", { body: { email: m.email, password: PASSWORD } })).body.token as string;
  return { token, userId: m.userId };
}
const sku = () => `Q-${randomUUID().slice(0, 8)}`;
async function item(t: string, approve = true) {
  const res = await api.call("POST", "/catalog/items", { token: t, body: { kind: "product", sku: sku(), name: "Bomba", unit: "pza" } });
  if (approve) await api.call("POST", `/catalog/items/${res.body.id}/approve`, { token: t });
  return { id: res.body.id as string, sku: res.body.sku as string };
}
async function priceList(t: string, prices: Array<[{ id: string }, string]>, approve = true, currency = "MXN") {
  const id = (await api.call("POST", "/catalog/price-lists", { token: t, body: { name: `L-${randomUUID().slice(0, 6)}`, currency } })).body.id as string;
  for (const [it, price] of prices) await api.call("PUT", `/catalog/price-lists/${id}/entries/${it.id}`, { token: t, body: { unitPrice: price } });
  if (approve) await api.call("POST", `/catalog/price-lists/${id}/approve`, { token: t });
  return id;
}
async function opportunity(t: string, assignTo?: string) {
  const p = (await api.call("POST", "/prospects", { token: t, body: { name: `Co ${randomUUID().slice(0, 6)}`, domain: `q-${randomUUID().slice(0, 8)}.example` } })).body;
  const leadId = (await api.call("POST", `/prospects/${p.id}/replies`, { token: t, body: { text: "Queremos comprar" } })).body.effects.leadId;
  await api.call("POST", `/leads/${leadId}/decision`, { token: t, body: { decision: "accept" } });
  const opp = (await api.call("POST", "/opportunities", { token: t, body: { leadId, title: "Venta" } })).body;
  if (assignTo) await api.call("POST", `/opportunities/${opp.id}/assign`, { token: t, body: { userId: assignTo } });
  return opp.id as string;
}
/** Admin world: two approved items priced in an approved list, an open opportunity. */
async function world(a: Account) {
  const big = await item(a.token);
  const small = await item(a.token);
  const list = await priceList(a.token, [[big, "100"], [small, "0.3333"]]);
  const opp = await opportunity(a.token);
  await qualify(a.token, opp);
  return { big, small, list, opp };
}
async function qualify(t: string, opp: string) {
  for (const to of ["contacted", "qualification"]) await api.call("POST", `/opportunities/${opp}/stage`, { token: t, body: { stage: to } });
}
const newQuote = (t: string, w: { opp: string; list: string }, extra: Record<string, unknown> = {}) => api.call("POST", "/quotes", { token: t, body: { opportunityId: w.opp, priceListId: w.list, ...extra } });
const addLine = (t: string, qid: string, s: string, quantity: string, discountPercent?: string) =>
  api.call("POST", `/quotes/${qid}/lines`, { token: t, body: { sku: s, quantity, ...(discountPercent ? { discountPercent } : {}) } });
const act = (t: string, qid: string, action: string) => api.call("POST", `/quotes/${qid}/${action}`, { token: t });
const decide = (t: string, qid: string, decision: string) => api.call("POST", `/quotes/${qid}/decision`, { token: t, body: { decision } });
const setLimit = (t: string, maxDiscountPercent: string) => api.call("PUT", "/quotes/settings", { token: t, body: { maxDiscountPercent } });

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});

describe("creating quotes", () => {
  it("needs an open opportunity and an APPROVED price list; the currency comes from the list; numbers are sequential per organization", async () => {
    const a = await register("create");
    const w = await world(a);
    const first = await newQuote(a.token, w, { validUntil: "2099-12-31", taxRate: "16", notes: "Condiciones: pago a 30 días" });
    expect(first.status).toBe(201);
    expect(QuoteDetailDto.safeParse(first.body).success).toBe(true);
    expect(first.body).toMatchObject({ number: 1, label: "Q-0001", status: "draft", currency: "MXN", validUntil: "2099-12-31", taxRate: "16.0000", total: "0.0000", lines: [], requiresDiscountApproval: false });
    expect((await newQuote(a.token, w)).body.label).toBe("Q-0002");

    const draftList = await priceList(a.token, [[w.big, "5"]], false);
    expect((await newQuote(a.token, { opp: w.opp, list: draftList })).status).toBe(409);
    expect((await newQuote(a.token, { opp: w.opp, list: randomUUID() })).status).toBe(404);
    expect((await newQuote(a.token, { opp: randomUUID(), list: w.list })).status).toBe(404);
    const closed = await opportunity(a.token);
    await api.call("POST", `/opportunities/${closed}/stage`, { token: a.token, body: { stage: "lost", lossReason: "x" } });
    expect((await newQuote(a.token, { opp: closed, list: w.list })).status).toBe(409);
    for (const body of [{}, { opportunityId: w.opp }, { opportunityId: w.opp, priceListId: w.list, taxRate: "101" }, { opportunityId: w.opp, priceListId: w.list, taxRate: "abc" }, { opportunityId: w.opp, priceListId: w.list, currency: "USD" }, { opportunityId: w.opp, priceListId: w.list, total: "1" }]) {
      expect((await api.call("POST", "/quotes", { token: a.token, body })).status).toBe(400);
    }
  });
});

describe("lines come only from approved evidence, with exact arithmetic", () => {
  it("snapshots item version, evidence refs and price, and computes line and quote totals exactly", async () => {
    const a = await register("lines");
    const w = await world(a);
    const q = (await newQuote(a.token, w, { taxRate: "16" })).body.id as string;
    const r1 = await addLine(a.token, q, w.big.sku, "10", "12.5");
    expect(r1.status).toBe(201);
    expect(r1.body.lines[0]).toMatchObject({
      position: 1, sku: w.big.sku, itemName: "Bomba", itemVersion: 1, unit: "pza", quantity: "10.0000", unitPrice: "100.0000", discountPercent: "12.50",
      gross: "1000.0000", discountAmount: "125.0000", lineTotal: "875.0000",
    });
    expect(r1.body.lines[0].itemRef).toBe(`item:${w.big.id}:v1`);
    expect(r1.body.lines[0].priceRef).toMatch(/^price:[0-9a-f-]{36}$/);
    const r2 = await addLine(a.token, q, w.small.sku, "3");
    expect(r2.body.lines[1]).toMatchObject({ unitPrice: "0.3333", gross: "0.9999", lineTotal: "0.9999" });
    // subtotal 1000.9999 - discount 125 = 875.9999 ; tax 16% = 140.159984 -> 140.1600 ; total 1016.1599
    expect(r2.body).toMatchObject({ subtotal: "1000.9999", discountTotal: "125.0000", taxTotal: "140.1600", total: "1016.1599" });

    expect((await api.call("PATCH", `/quotes/${q}`, { token: a.token, body: { taxRate: null } })).body).toMatchObject({ taxTotal: "0.0000", total: "875.9999" });
    const removed = await api.call("DELETE", `/quotes/${q}/lines/${r1.body.lines[0].id}`, { token: a.token });
    expect(removed.body).toMatchObject({ subtotal: "0.9999", discountTotal: "0.0000", total: "0.9999" });
    expect(removed.body.lines).toHaveLength(1);
  });

  it("PostgreSQL re-computes and agrees with the application on arbitrary amounts (checked when the quote is sent)", async () => {
    const a = await register("crosscheck");
    const items = [await item(a.token), await item(a.token), await item(a.token), await item(a.token), await item(a.token)];
    const prices = ["0.0001", "19.9999", "1234.5678", "0.3333", "99999.9999"];
    const list = await priceList(a.token, items.map((it, i) => [it, prices[i] as string]));
    const opp = await opportunity(a.token);
    await setLimit(a.token, "100");
    const q = (await newQuote(a.token, { opp, list }, { taxRate: "7.5" })).body.id as string;
    const qtys = ["1", "0.5", "3.3333", "12345.6789", "2"];
    const discs = ["0", "33.33", "0.01", "99.99", "12.5"];
    for (const [i, it] of items.entries()) expect((await addLine(a.token, q, it.sku, qtys[i] as string, discs[i] as string)).status).toBe(201);
    const sent = await act(a.token, q, "send");
    expect(sent.status).toBe(200); // the database trigger recomputed subtotal, discount, tax and total from the lines and compared them
    expect(sent.body.status).toBe("sent");
    const sums = (await owner.query("SELECT sum(gross) AS g, sum(discount_amount) AS d FROM quote_lines WHERE quote_id = $1", [q])).rows[0];
    expect(sent.body.subtotal).toBe(Number(sums.g).toFixed(4));
    expect(sent.body.discountTotal).toBe(Number(sums.d).toFixed(4));
  });

  it("refuses SKUs without approved evidence and says why; malformed amounts are rejected", async () => {
    const a = await register("noev");
    const w = await world(a);
    const draftItem = await item(a.token, false);
    const unpriced = await item(a.token);
    const q = (await newQuote(a.token, w)).body.id as string;
    const draft = await addLine(a.token, q, draftItem.sku, "1");
    expect(draft.status).toBe(409);
    expect(draft.body.details).toMatchObject({ item: "item_not_approved" });
    expect((await addLine(a.token, q, unpriced.sku, "1")).body.details).toEqual({ item: "ok", price: "no_price_for_item" });
    expect((await addLine(a.token, q, "DOES-NOT-EXIST", "1")).body.details.item).toBe("item_not_found");
    expect((await addLine(a.token, q, w.big.sku, "1")).status).toBe(201);
    expect((await addLine(a.token, q, w.big.sku, "2")).status).toBe(409); // already on the quote
    for (const [qty, disc] of [["0", undefined], ["-1", undefined], ["1e3", undefined], ["1.00001", undefined], ["abc", undefined], ["1", "100.01"], ["1", "-5"], ["1", "10.555"]]) {
      expect((await addLine(a.token, q, w.small.sku, qty as string, disc)).status).toBe(400);
    }
    expect((await api.call("POST", `/quotes/${q}/lines`, { token: a.token, body: { sku: w.small.sku, quantity: "1", unitPrice: "0.01" } })).status).toBe(400); // prices are never typed in
    expect((await api.call("POST", `/quotes/${q}/lines`, { token: a.token, body: { sku: w.small.sku, quantity: 1 } })).status).toBe(400);
  });

  it("the database re-checks evidence on direct SQL", async () => {
    const a = await register("lines-db");
    const w = await world(a);
    const q = (await newQuote(a.token, w)).body.id as string;
    await addLine(a.token, q, w.big.sku, "1");
    const entry = (await owner.query("SELECT e.id FROM price_list_entries e WHERE e.price_list_id = $1 AND e.item_id = $2", [w.list, w.small.id])).rows[0].id as string;
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[]) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    const insert = (unitPrice: string, version: number, gross: string) =>
      denied(
        `INSERT INTO quote_lines (organization_id, quote_id, position, item_id, sku, item_name, item_version, item_ref, price_ref, quantity, unit_price, discount_percent, gross, discount_amount, line_total)
         VALUES ($1,$2,9,$3,'s','n',$4,$7,$8,1,$5,0,$6,0,$6)`,
        [a.orgId, q, w.small.id, version, unitPrice, gross, `item:${w.small.id}:v${version}`, `price:${entry}`],
      );
    expect(await insert("0.0001", 1, "0.0001")).toMatch(/approved price list entry/); // invented price
    expect(await insert("0.3333", 2, "0.3333")).toMatch(/item must be approved/); // wrong item version
    expect(await insert("0.3333", 1, "9.0000")).toMatch(/violates check constraint/); // inconsistent gross
  });
});

describe("discount approval", () => {
  it("every discount needs an administrator by default; approval is bound to the exact lines; the limit is configurable", async () => {
    const a = await register("disc");
    const sm = await member(a.orgId, "sales_manager");
    const w = await world(a);
    expect((await api.call("GET", "/quotes/settings", { token: a.token })).body).toEqual({ maxDiscountPercent: "0.00" });
    const q = (await newQuote(sm.token, w)).body.id as string;
    const withDisc = await addLine(sm.token, q, w.big.sku, "1", "5");
    expect(withDisc.body).toMatchObject({ requiresDiscountApproval: true, discountApproved: false });
    expect((await act(sm.token, q, "send")).status).toBe(409); // no approval
    expect((await act(sm.token, q, "approve-discount")).status).toBe(403);
    expect((await act(a.token, q, "approve-discount")).body.discountApproved).toBe(true);

    await addLine(sm.token, q, w.small.sku, "1"); // changing the lines withdraws the approval
    expect((await api.call("GET", `/quotes/${q}`, { token: a.token })).body.discountApproved).toBe(false);
    expect((await act(sm.token, q, "send")).status).toBe(409);
    await act(a.token, q, "approve-discount");
    expect((await act(sm.token, q, "send")).status).toBe(200);

    // a configured limit lets small discounts through without approval
    expect((await setLimit(sm.token, "10")).status).toBe(403);
    expect((await setLimit(a.token, "10")).body).toEqual({ maxDiscountPercent: "10.00" });
    const w2 = await world(a);
    const q2 = (await newQuote(sm.token, w2)).body.id as string;
    expect((await addLine(sm.token, q2, w2.big.sku, "1", "10")).body.requiresDiscountApproval).toBe(false);
    expect((await act(a.token, q2, "approve-discount")).status).toBe(409); // nothing above the limit
    expect((await act(sm.token, q2, "send")).status).toBe(200);
    const q3 = (await newQuote(sm.token, w2)).body.id as string;
    expect((await addLine(sm.token, q3, w2.big.sku, "1", "10.01")).body.requiresDiscountApproval).toBe(true);
    for (const v of ["101", "-1", "abc", "10.555"]) expect((await setLimit(a.token, v)).status).toBe(400);
  });

  it("the database refuses to send a discounted quote without a current approval, and only org_admin can approve", async () => {
    const a = await register("disc-db");
    const sm = await member(a.orgId, "sales_manager");
    const w = await world(a);
    const q = (await newQuote(sm.token, w)).body.id as string;
    await addLine(sm.token, q, w.big.sku, "1", "5");
    const smCtx = { organizationId: a.orgId, userId: sm.userId, role: "sales_manager" };
    const denied = (ctx: typeof smCtx, sql: string, params: unknown[]) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied(smCtx, "UPDATE quotes SET discount_approved_by = $2, discount_approved_at = now(), lines_hash = 'x' WHERE id = $1", [q, sm.userId])).toMatch(/only org_admin/);
    const row = (await owner.query("SELECT subtotal, discount_total, tax_total, total FROM quotes WHERE id = $1", [q])).rows[0];
    expect(await denied(smCtx, "UPDATE quotes SET status = 'sent' WHERE id = $1", [q])).toMatch(/needs a current approval/);
    expect(row.total).toBe("95.0000");
  });
});

describe("sending freezes the quote", () => {
  it("re-verifies evidence at send time, then becomes an immutable snapshot", async () => {
    const a = await register("send");
    await setLimit(a.token, "100");
    const w = await world(a);
    const stale = (await newQuote(a.token, w)).body.id as string;
    await addLine(a.token, stale, w.big.sku, "2");
    await api.call("POST", `/catalog/items/${w.big.id}/archive`, { token: a.token }); // evidence disappears before sending
    const refused = await act(a.token, stale, "send");
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/no longer backed by approved evidence/);
    await api.call("POST", `/catalog/items/${w.big.id}/restore`, { token: a.token });

    const q = (await newQuote(a.token, w, { validUntil: "2099-01-01" })).body.id as string;
    expect((await act(a.token, q, "send")).status).toBe(409); // no lines
    await addLine(a.token, q, w.big.sku, "2");
    const sent = await act(a.token, q, "send");
    expect(sent.body).toMatchObject({ status: "sent", total: "200.0000" });
    expect(sent.body.sentAt).toBeTruthy();
    const opp = await api.call("GET", `/opportunities/${w.opp}`, { token: a.token });
    expect(opp.body.stage).toBe("quote_sent");
    expect(opp.body.timeline.some((t: { note?: string }) => t.note?.includes("Q-0002"))).toBe(true);

    // frozen: no API edits, and not even a catalog change alters the snapshot
    expect((await api.call("PATCH", `/quotes/${q}`, { token: a.token, body: { notes: "x" } })).status).toBe(409);
    expect((await addLine(a.token, q, w.small.sku, "1")).status).toBe(409);
    expect((await api.call("DELETE", `/quotes/${q}/lines/${sent.body.lines[0].id}`, { token: a.token })).status).toBe(409);
    expect((await act(a.token, q, "send")).status).toBe(409);
    await api.call("POST", `/catalog/items/${w.big.id}/archive`, { token: a.token });
    expect((await api.call("GET", `/quotes/${q}`, { token: a.token })).body).toMatchObject({ total: "200.0000", lines: [{ unitPrice: "100.0000", itemName: "Bomba" }] });
    await expect(owner.query("UPDATE quotes SET total = 1, subtotal = 1 WHERE id = $1", [q])).rejects.toThrow(/immutable/);
    await expect(owner.query("UPDATE quote_lines SET quantity = 99 WHERE quote_id = $1", [q])).rejects.toThrow(/draft/);
    await expect(owner.query("DELETE FROM quote_lines WHERE quote_id = $1", [q])).rejects.toThrow(/draft/);
  });

  it("the database cross-checks the totals when sending", async () => {
    const a = await register("totals");
    await setLimit(a.token, "100");
    const w = await world(a);
    const q = (await newQuote(a.token, w)).body.id as string;
    await addLine(a.token, q, w.big.sku, "1");
    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const msg = await asRuntime(ctx, async (c) => c.query("UPDATE quotes SET status = 'sent', total = 999, subtotal = 999 WHERE id = $1", [q]).then(() => "NO ERROR", (e: Error) => e.message));
    expect(msg).toMatch(/totals do not match/);
  });
});

describe("decisions and sales", () => {
  it("accepting creates the sale, wins the opportunity and links lead -> opportunity -> quote -> sale", async () => {
    const a = await register("accept");
    const w = await world(a);
    const q = (await newQuote(a.token, w, { taxRate: "16" })).body.id as string;
    await addLine(a.token, q, w.big.sku, "3");
    expect((await decide(a.token, q, "accept")).status).toBe(409); // still a draft
    await act(a.token, q, "send");
    const accepted = await decide(a.token, q, "accept");
    expect(accepted.body).toMatchObject({ status: "accepted", total: "348.0000" });
    expect(accepted.body.decidedAt).toBeTruthy();
    expect((await api.call("GET", `/opportunities/${w.opp}`, { token: a.token })).body).toMatchObject({ stage: "won" });
    const sales = (await api.call("GET", "/sales", { token: a.token })).body.items;
    expect(sales).toHaveLength(1);
    expect(sales[0]).toMatchObject({ quoteId: q, quoteNumber: 1, opportunityId: w.opp, total: "348.0000", currency: "MXN" });
    const opp = (await api.call("GET", `/opportunities/${w.opp}`, { token: a.token })).body;
    expect(sales[0].leadId).toBe(opp.leadId);
    expect(sales[0].prospectId).toBe(opp.prospect.id);
    for (const again of ["accept", "reject", "cancel"]) expect((await decide(a.token, q, again)).status).toBe(409);
    expect((await newQuote(a.token, w)).status).toBe(409); // the opportunity is closed

    const ctx = { organizationId: a.orgId, userId: a.userId, role: "org_admin" };
    const denied = (sql: string, params: unknown[] = []) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE sales SET total = 1")).toMatch(/permission denied/);
    expect(await denied("DELETE FROM sales")).toMatch(/permission denied/);
    expect(await denied("INSERT INTO sales (organization_id, quote_id, opportunity_id, lead_id, prospect_id, total, currency, closed_by) VALUES ($1,$2,$3,$4,$5,348,'MXN',$6)", [a.orgId, q, w.opp, opp.leadId, opp.prospect.id, a.userId])).toMatch(/unique|duplicate/);
  });

  it("rejecting or cancelling leaves the opportunity open; an expired quote cannot be accepted", async () => {
    const a = await register("reject");
    const w = await world(a);
    const rejected = (await newQuote(a.token, w)).body.id as string;
    await addLine(a.token, rejected, w.big.sku, "1");
    await act(a.token, rejected, "send");
    expect((await decide(a.token, rejected, "reject")).body.status).toBe("rejected");
    expect((await api.call("GET", `/opportunities/${w.opp}`, { token: a.token })).body.stage).toBe("quote_sent");
    expect((await api.call("GET", "/sales", { token: a.token })).body.items).toEqual([]);

    const cancelled = (await newQuote(a.token, w)).body.id as string;
    expect((await decide(a.token, cancelled, "cancel")).body.status).toBe("cancelled"); // a draft can be cancelled
    expect((await addLine(a.token, cancelled, w.big.sku, "1")).status).toBe(409);

    const expiring = (await newQuote(a.token, w, { validUntil: "2099-01-01" })).body.id as string;
    await addLine(a.token, expiring, w.big.sku, "1");
    await act(a.token, expiring, "send");
    await owner.query("ALTER TABLE quotes DISABLE TRIGGER quotes_guard");
    try {
      await owner.query("UPDATE quotes SET valid_until = '2020-01-01' WHERE id = $1", [expiring]); // simulate the validity date passing
    } finally {
      await owner.query("ALTER TABLE quotes ENABLE TRIGGER quotes_guard");
    }
    const late = await decide(a.token, expiring, "accept");
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/expired/);
    expect((await api.call("GET", `/opportunities/${w.opp}`, { token: a.token })).body.stage).not.toBe("won");
    expect((await decide(a.token, expiring, "cancel")).body.status).toBe("cancelled");
    expect((await api.call("GET", "/quotes?status=sent", { token: a.token })).body.items).toEqual([]);
    expect((await api.call("GET", `/quotes?opportunityId=${w.opp}&limit=2`, { token: a.token })).body.items).toHaveLength(2);
  });
});

describe("sellers", () => {
  it("quote only their own opportunities and cannot approve discounts or change the limit", async () => {
    const a = await register("seller");
    const s1 = await member(a.orgId, "seller");
    const s2 = await member(a.orgId, "seller");
    const w = await world(a);
    const mine = await opportunity(a.token, s1.userId);
    const theirs = await opportunity(a.token, s2.userId);
    expect((await newQuote(s1.token, { opp: theirs, list: w.list })).status).toBe(404); // not visible to this seller
    await qualify(s1.token, mine);
    const q = (await newQuote(s1.token, { opp: mine, list: w.list })).body.id as string;
    expect((await addLine(s1.token, q, w.big.sku, "1")).status).toBe(201);
    const other = (await newQuote(s2.token, { opp: theirs, list: w.list })).body.id as string;
    expect((await api.call("GET", `/quotes/${other}`, { token: s1.token })).status).toBe(404);
    expect((await addLine(s1.token, other, w.big.sku, "1")).status).toBe(404);
    expect((await api.call("GET", "/quotes", { token: s1.token })).body.items.map((x: { id: string }) => x.id)).toEqual([q]);
    expect((await act(s1.token, q, "approve-discount")).status).toBe(403);
    expect((await setLimit(s1.token, "50")).status).toBe(403);
    await setLimit(a.token, "100");
    expect((await act(s1.token, q, "send")).status).toBe(200);
    expect((await decide(s1.token, q, "accept")).body.status).toBe("accepted");
    expect((await api.call("GET", "/sales", { token: s1.token })).body.items).toHaveLength(1);
    expect((await api.call("GET", "/sales", { token: s2.token })).body.items).toEqual([]);
    expect((await api.call("GET", "/sales", { token: a.token })).body.items).toHaveLength(1);
  });
});

describe("RBAC matrix", () => {
  const expected: Record<MembershipRole, { read: number; manage: number; approve: number }> = {
    org_admin: { read: 200, manage: 201, approve: 200 },
    sales_manager: { read: 200, manage: 201, approve: 403 },
    seller: { read: 200, manage: 201, approve: 403 },
    campaign_manager: { read: 403, manage: 403, approve: 403 },
    analyst: { read: 200, manage: 403, approve: 403 },
    viewer: { read: 200, manage: 403, approve: 403 },
  };
  it("covers every role", () => expect(Object.keys(expected).sort()).toEqual([...MEMBERSHIP_ROLES].sort()));

  it.each(MEMBERSHIP_ROLES)("%s", async (role) => {
    const a = await register(`rbac-${role}`);
    const actor = role === "org_admin" ? { token: a.token, userId: a.userId } : await member(a.orgId, role);
    const w = await world(a);
    if (role === "seller") await api.call("POST", `/opportunities/${w.opp}/assign`, { token: a.token, body: { userId: actor.userId } });
    const e = expected[role];
    expect((await api.call("GET", "/quotes", { token: actor.token })).status).toBe(e.read);
    expect((await api.call("GET", "/quotes/settings", { token: actor.token })).status).toBe(e.read);
    expect((await api.call("GET", "/sales", { token: actor.token })).status).toBe(e.read);
    expect((await newQuote(actor.token, w)).status).toBe(e.manage);
    const q = (await newQuote(a.token, w)).body.id as string;
    expect((await addLine(actor.token, q, w.big.sku, "1", "5")).status).toBe(e.manage === 201 ? 201 : 403);
    expect((await act(actor.token, q, "approve-discount")).status).toBe(e.approve === 200 ? 200 : 403);
    expect((await setLimit(actor.token, "5")).status).toBe(e.approve);
  });
});

describe("tenant isolation", () => {
  it("tenant B cannot see or touch A's quotes and cannot quote with A's opportunities or price lists", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const w = await world(a);
    const q = (await newQuote(a.token, w)).body.id as string;
    await addLine(a.token, q, w.big.sku, "1");
    const wb = await world(b);

    expect((await api.call("GET", "/quotes", { token: b.token })).body.items).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `/quotes/${q}`, undefined], ["PATCH", `/quotes/${q}`, { notes: "x" }], ["POST", `/quotes/${q}/lines`, { sku: w.big.sku, quantity: "1" }],
      ["POST", `/quotes/${q}/send`, undefined], ["POST", `/quotes/${q}/decision`, { decision: "cancel" }], ["POST", `/quotes/${q}/approve-discount`, undefined],
    ] as const) expect((await api.call(method, path, { token: b.token, ...(body ? { body } : {}) })).status).toBe(404);
    expect((await newQuote(b.token, { opp: w.opp, list: wb.list })).status).toBe(404); // A's opportunity
    expect((await newQuote(b.token, { opp: wb.opp, list: w.list })).status).toBe(404); // A's price list
    expect((await addLine(b.token, (await newQuote(b.token, wb)).body.id, w.big.sku, "1")).status).toBe(409); // A's SKU is "item_not_found" in B
    expect((await api.call("GET", "/quotes/settings", { token: b.token })).body.maxDiscountPercent).toBe("0.00");

    const ctx = { organizationId: b.orgId, userId: b.userId, role: "org_admin" };
    await asRuntime(ctx, async (c) => {
      for (const t of ["quotes", "quote_lines", "sales", "quote_counters", "quote_settings"]) expect((await c.query(`SELECT 1 FROM ${t}`)).rowCount).toBe(t === "quotes" || t === "quote_counters" ? 1 : 0);
    });
    const denied = (sql: string, params: unknown[]) => asRuntime(ctx, async (c) => c.query(sql, params).then(() => "NO ERROR", (e: Error) => e.message));
    expect(await denied("UPDATE quotes SET organization_id = $1", [a.orgId])).toMatch(/permission denied/);
    expect(await denied("INSERT INTO quotes (organization_id, opportunity_id, number, price_list_id, currency, created_by, updated_at) VALUES ($1,$2,99,$3,'MXN',$4, now())", [b.orgId, w.opp, wb.list, b.userId])).toMatch(/foreign key|row-level security|open opportunity/);
  });
});
