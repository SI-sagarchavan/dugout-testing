import { NeedsSetup } from "@dugout/contracts";
import { describe, expect, it } from "vitest";
import { McpAuthError, setupFailure } from "../src/index.ts";

describe("a setup failure behind an error", () => {
  it("is found by its type, however deep the transport wrapped it", () => {
    const missing = new McpAuthError("no grant for tenant t on http://x");
    expect(setupFailure(missing)).toBe(missing);
    const wrapped = new Error("connect failed", { cause: new Error("fetch", { cause: missing }) });
    expect(setupFailure(wrapped)).toBe(missing);
    // a setup another package threw reads as one too
    expect(setupFailure(new Error("x", { cause: new NeedsSetup("sign in") }))?.setup).toBe(
      "sign in",
    );
  });

  it("is not read from an error's words", () => {
    expect(setupFailure(new Error("no grant for tenant t on http://x"))).toBeUndefined();
    expect(setupFailure("no grants file")).toBeUndefined();
  });
});
