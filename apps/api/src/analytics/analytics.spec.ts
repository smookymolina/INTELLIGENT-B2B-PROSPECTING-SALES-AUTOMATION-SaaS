import { describe, expect, it } from "vitest";
import { resolveWindow } from "./analytics.service.js";

describe("resolveWindow", () => {
  const now = new Date("2026-10-30T15:45:00.000Z");

  it("defaults to the last 30 UTC calendar days, inclusive of today", () => {
    const w = resolveWindow({}, now);
    expect(w).toMatchObject({ from: "2026-10-01", to: "2026-10-30" });
    expect(w.start.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-31T00:00:00.000Z"); // exclusive bound = start of the day after `to`
  });

  it("keeps explicit bounds and derives the missing one", () => {
    expect(resolveWindow({ from: "2026-01-01", to: "2026-01-01" }, now).end.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(resolveWindow({ to: "2026-03-31" }, now).from).toBe("2026-03-02");
    expect(resolveWindow({ from: "2026-02-01" }, now)).toMatchObject({ from: "2026-02-01", to: "2026-10-30" });
  });
});
