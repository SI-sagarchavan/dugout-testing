import { describe, expect, it } from "vitest";
import { createRedactor, DEEPSEEK_PRICING, policyViolation, priceTokens } from "../src/index.ts";

describe("redactor", () => {
  const redact = createRedactor();

  it.each([
    ["mail me at a.b+c@example.co.in", "mail me at [REDACTED:email]"],
    ["call +91 98765 43210 now", "call [REDACTED:phone] now"],
    ["call 9876543210", "call [REDACTED:phone]"],
    ["intl +44 20 7946 0958", "intl [REDACTED:phone]"],
    ["aadhaar 2345 6789 0123", "aadhaar [REDACTED:aadhaar]"],
    ["PAN ABCDE1234F", "PAN [REDACTED:pan]"],
    ["key sk-abcdefghijklmnopqrstuvwx", "key [REDACTED:api_key]"],
    ["Authorization: Bearer abcdefghijklmnop1234", "Authorization: [REDACTED:bearer]"],
  ])("redacts %j", (input, expected) => {
    expect(redact.text(input)).toBe(expected);
  });

  it.each([
    "Lions won by 7 wickets at 19:30 on 2026-11-02",
    "Scored 120 runs off 98 balls",
    "Attendance 45000",
  ])("leaves match copy alone: %j", (input) => {
    expect(redact.text(input)).toBe(input);
  });

  it("redacts strings inside nested values and keeps keys", () => {
    expect(redact.value({ email: ["x@y.io"], n: 3 })).toEqual({
      email: ["[REDACTED:email]"],
      n: 3,
    });
  });
});

describe("policyViolation", () => {
  it.each([
    [{ path: "../secrets" }, "path traversal"],
    [{ path: "a\\..\\b" }, "path traversal"],
    [{ nested: [{ s: "x\0y" }] }, "NUL byte"],
    [{ tenant_id: "other" }, "tenant is set by the harness"],
    [{ token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "secret (github_token)"],
  ])("refuses %j", (input, reason) => {
    expect(policyViolation(input)).toContain(reason);
  });

  it("allows ordinary arguments", () => {
    expect(policyViolation({ fixtureId: "f-1", note: "v1..v2 not a path", n: 2 })).toBeUndefined();
  });
});

describe("pricing", () => {
  const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    outputTokens: 100_000,
    reasoningTokens: 0,
  };

  it("charges the list rate at peak and half off-peak, but budgets at list", () => {
    const peak = priceTokens(
      DEEPSEEK_PRICING,
      "deepseek-flash",
      tokens,
      new Date("2026-10-28T07:00:00Z"),
    );
    const offPeak = priceTokens(
      DEEPSEEK_PRICING,
      "deepseek-flash",
      tokens,
      new Date("2026-10-31T07:00:00Z"),
    );
    // 0.5M hits * 0.006 + 0.5M misses * 0.30 + 0.1M out * 1.20 = 0.003 + 0.15 + 0.12
    expect(peak.costUsd).toBeCloseTo(0.273);
    expect(peak.budgetCostUsd).toBeCloseTo(0.273);
    expect(offPeak.costUsd).toBeCloseTo(0.1365);
    expect(offPeak.budgetCostUsd).toBeCloseTo(0.273);
  });

  it("refuses to price an unknown model", () => {
    expect(() => priceTokens(DEEPSEEK_PRICING, "mystery", tokens, new Date())).toThrow("no price");
  });
});
