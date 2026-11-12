import { describe, expect, it } from "vitest";
import { hooksOf } from "../src/agent.ts";

const item = (at: string, did: Record<string, unknown>, corrected?: string) => ({
  lastSeenAt: `${at}T10:00:00.000Z`,
  value: { did, ...(corrected ? { corrected: [{ what: corrected }] } : {}) },
});

/** A store with the section's records, newest first, as `builds` answers them. */
const store = (items: unknown[]) =>
  ({ builds: async () => items }) as unknown as Parameters<typeof hooksOf>[0];

describe("the hooks a section already has (built.load's hooks)", () => {
  it("lists every hook earlier runs answered with, newest first, one entry per hook, whatever the outcome", async () => {
    const hooks = await hooksOf(
      store([
        item("2026-11-12", {
          hookId: "dugout_brave_photo_galleries",
          basis: "sources",
          input: {},
          covers: ["gallery title → galleries[].title"],
          missing: ["photo count: asset_count is null for every item"],
        }),
        item("2026-11-11", { hookId: null, basis: "found" }),
        item("2026-11-10", { hookId: "dugout_brave_photo_galleries", basis: "found" }),
        item("2026-11-09", { hookId: "dugout_brave_news" }, "a person bound another feed"),
      ]),
      "sb",
      "s2:section",
    );
    expect(hooks.map((h) => h.hookId)).toEqual([
      "dugout_brave_photo_galleries",
      "dugout_brave_news",
    ]);
    expect(hooks[0]).toMatchObject({
      at: "2026-11-12",
      how: "sources",
      missing: ["photo count: asset_count is null for every item"],
    });
    expect(hooks[1]?.corrected).toBe("a person bound another feed");
  });

  it("says nothing without a section or a store", async () => {
    expect(await hooksOf(undefined, "sb", "s2:section")).toEqual([]);
    expect(await hooksOf(store([]), "sb", undefined)).toEqual([]);
  });
});
