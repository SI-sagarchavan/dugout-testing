import { describe, expect, it } from "vitest";
import { createRedactor, policyViolation, priceTokens } from "../src/index.ts";

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
  const nova = { input: 0.041, cacheRead: 0.01025, output: 0.164 };
  const tokens = {
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    cacheWriteInputTokens: 0,
    outputTokens: 100_000,
    reasoningTokens: 0,
  };

  it("prices cache reads, uncached input and output", () => {
    const cost = priceTokens(nova, tokens);
    // 0.5M read * 0.01025 + 0.5M uncached * 0.041 + 0.1M out * 0.164 = 0.005125 + 0.0205 + 0.0164
    expect(cost.costUsd).toBeCloseTo(0.042025);
    expect(cost.budgetCostUsd).toBe(cost.costUsd);
  });

  it("prices cache writes at their own price, or at the input price when there is none", () => {
    const sonnet = { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 };
    const written = { ...tokens, cachedInputTokens: 0, cacheWriteInputTokens: 400_000 };
    // 0.6M uncached * 2 + 0.4M written * 2.5 + 0.1M out * 10 = 1.2 + 1 + 1
    expect(priceTokens(sonnet, written).costUsd).toBeCloseTo(3.2);
    // 0.6M * 0.041 + 0.4M * 0.041 + 0.1M * 0.164
    expect(priceTokens(nova, written).costUsd).toBeCloseTo(0.041 + 0.0164);
  });
});
