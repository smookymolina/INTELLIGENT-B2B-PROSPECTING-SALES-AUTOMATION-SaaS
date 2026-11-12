import { describe, expect, it } from "vitest";
import { loadEmailCapConfig } from "./email.config.js";

describe("email cap config", () => {
  it("defaults to 50 per hour and 200 per day", () => {
    expect(loadEmailCapConfig({})).toEqual({ maxPerHour: 50, maxPerDay: 200 });
    expect(loadEmailCapConfig({ EMAIL_MAX_PER_HOUR: " ", EMAIL_MAX_PER_DAY: "" })).toEqual({ maxPerHour: 50, maxPerDay: 200 });
  });

  it("reads positive integers from the environment", () => {
    expect(loadEmailCapConfig({ EMAIL_MAX_PER_HOUR: "10", EMAIL_MAX_PER_DAY: "40" })).toEqual({ maxPerHour: 10, maxPerDay: 40 });
  });

  it.each(["0", "-1", "1.5", "abc", "1e3"])("refuses EMAIL_MAX_PER_HOUR=%s", (v) => {
    expect(() => loadEmailCapConfig({ EMAIL_MAX_PER_HOUR: v })).toThrow(/EMAIL_MAX_PER_HOUR/);
  });

  it("refuses an hourly cap above the daily one", () => {
    expect(() => loadEmailCapConfig({ EMAIL_MAX_PER_HOUR: "300" })).toThrow(/must not exceed/);
  });
});
