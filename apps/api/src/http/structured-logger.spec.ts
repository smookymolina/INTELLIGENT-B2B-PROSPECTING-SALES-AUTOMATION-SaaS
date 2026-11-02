import { describe, expect, it } from "vitest";
import { StructuredLogger, redact } from "./structured-logger.js";

const make = () => {
  const lines: string[] = [];
  const logger = new StructuredLogger((l) => lines.push(l), undefined, () => new Date("2026-10-31T00:00:00Z"));
  return { lines, logger };
};

describe("redact", () => {
  it("masks bearer tokens, JWTs, key=value secrets and emails", () => {
    const out = redact("auth Bearer abc.def-123 jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig password=hunter2 token: 'x y' mail ana@example.com");
    expect(out).not.toMatch(/abc\.def|hunter2|ana@example|eyJhbGci|x y/);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("[REDACTED_EMAIL]");
  });

  it("leaves harmless text intact", () => {
    expect(redact("request_id=42 unexpected TypeError")).toBe("request_id=42 unexpected TypeError");
  });
});

describe("StructuredLogger", () => {
  it("emits one parseable JSON line with level, context and redacted message", () => {
    const { lines, logger } = make();
    logger.error("login failed password=abc for bob@corp.io", "Auth");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({ ts: "2026-10-31T00:00:00.000Z", level: "error", context: "Auth", msg: "login failed password=[REDACTED] for [REDACTED_EMAIL]" });
  });

  it("drops debug/verbose by default and never prints error stacks", () => {
    const { lines, logger } = make();
    logger.debug("noise");
    logger.verbose("noise");
    logger.warn(new Error("boom token=zzz"), "Ctx");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string) as { msg: string };
    expect(parsed.msg).toBe("Error: boom token=[REDACTED]");
  });
});
