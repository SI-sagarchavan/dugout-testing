import { describe, expect, it } from "vitest";
import { firstName, initialOf } from "../src/health/person.js";

describe("people", () => {
  it("names the first name and the initial, never the full name", () => {
    expect(firstName("Priya Shah")).toBe("Priya");
    expect(initialOf("Priya Shah")).toBe("P");
    expect(initialOf("  amit rao ")).toBe("A");
  });

  it("does not leave a blank where there is no name", () => {
    expect(firstName("   ")).toBe("Anonymous");
    expect(initialOf("")).toBe("A");
  });
});
