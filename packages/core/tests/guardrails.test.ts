import { describe, expect, it } from "vitest";
import { BEDROCK_PRICING, createRedactor, policyViolation, priceTokens } from "../src/index.ts";

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

  it("prices cache hits, misses and output at the list rate", () => {
    const cost = priceTokens(BEDROCK_PRICING, "apac.amazon.nova-micro-v1:0", tokens, new Date());
    // 0.5M hits * 0.01025 + 0.5M misses * 0.041 + 0.1M out * 0.164 = 0.005125 + 0.0205 + 0.0164
    expect(cost.costUsd).toBeCloseTo(0.042025);
    expect(cost.budgetCostUsd).toBeCloseTo(0.042025);
  });

  it("charges the rate at the time of the call, but budgets at list", () => {
    const halfAfterNoon = {
      ...BEDROCK_PRICING,
      rateAt: (at: Date) => (at.getUTCHours() >= 12 ? 0.5 : 1),
    };
    const at = new Date("2026-10-30T13:00:00Z");
    const cost = priceTokens(halfAfterNoon, "apac.amazon.nova-micro-v1:0", tokens, at);
    expect(cost.costUsd).toBeCloseTo(0.0210125);
    expect(cost.budgetCostUsd).toBeCloseTo(0.042025);
  });

  it("refuses to price an unknown model", () => {
    expect(() => priceTokens(BEDROCK_PRICING, "mystery", tokens, new Date())).toThrow("no price");
  });
});
