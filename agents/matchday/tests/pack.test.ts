import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type Pack, PackSchema, PREVIEW_MAX_WORDS } from "../src/pack.ts";
import { createMatchdayTools } from "../src/tools.ts";

const preview = {
  title: "Mumbai Mariners v Chennai Chargers",
  body: "Mumbai Mariners host Chennai Chargers at Wankhede Arena on 2026-11-02, starting at 19:30.",
};

const pack = (extra: Partial<Pack> = {}): Pack => ({
  fixtureId: "c-101",
  channels: [],
  preview,
  social: null,
  push: null,
  headline: null,
  ...extra,
});

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

describe("pack rules", () => {
  it("accepts a preview on its own", () => {
    expect(PackSchema.safeParse(pack()).success).toBe(true);
  });

  it("rejects betting language, a long preview, and a channel that was not asked for", () => {
    const betting = pack({
      preview: { ...preview, body: "Place a bet on Mumbai Mariners at the ground tonight." },
    });
    const long = pack({ preview: { ...preview, body: words(PREVIEW_MAX_WORDS + 1) } });
    const extra = pack({ social: "Mumbai Mariners face Chennai Chargers tonight." });
    for (const bad of [betting, long, extra]) {
      expect(PackSchema.safeParse(bad).success).toBe(false);
    }
    const missing = PackSchema.safeParse(pack({ channels: ["social"], social: null }));
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(missing.error.issues.map((issue) => issue.message).join("\n")).toContain(
        "social is null",
      );
    }
  });

  it("requires social, push and headline in the schema, null when unused", () => {
    const schema = z.toJSONSchema(PackSchema, { io: "input" }) as { required?: string[] };
    expect(schema.required).toEqual(
      expect.arrayContaining(["social", "push", "headline", "channels", "preview"]),
    );
  });
});

describe("pack.save", () => {
  let packsDir: string;
  const ctx = { tenantId: "demo-cricket", runId: "run-1", signal: AbortSignal.timeout(5_000) };

  beforeEach(async () => {
    packsDir = await mkdtemp(join(tmpdir(), "packs-"));
  });

  const save = () => createMatchdayTools({ packsDir })[2];

  it("writes the pack, and writing it again changes nothing", async () => {
    const tool = save();
    const first = await tool.run(pack(), ctx);
    expect(first).toEqual({ saved: true, unchanged: false, fixtureId: "c-101" });
    const file = join(packsDir, "demo-cricket", "c-101.json");
    const written = JSON.parse(await readFile(file, "utf8"));
    expect(written.preview).toEqual(preview);
    expect(written.hash).toMatch(/^[a-f0-9]{12}$/);
    const before = (await stat(file)).mtimeMs;
    const second = await tool.run(pack(), ctx);
    expect(second).toMatchObject({ unchanged: true });
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("refuses a push without the kickoff time, and a headline that misses the home team", async () => {
    const tool = save();
    const push = pack({
      channels: ["push"],
      push: "Mumbai Mariners host Chennai Chargers tonight.",
    });
    await expect(tool.run(push, ctx)).rejects.toThrow("19:30");
    const headline = pack({
      channels: ["headline"],
      headline: "Chargers visit tonight",
    });
    await expect(tool.run(headline, ctx)).rejects.toThrow("Mumbai Mariners");
    await expect(stat(join(packsDir, "demo-cricket"))).rejects.toThrow();
  });

  it("keeps another tenant's fixture out", async () => {
    const tool = save();
    await expect(tool.run(pack({ fixtureId: "f-201" }), ctx)).rejects.toThrow("no fixture f-201");
  });
});
