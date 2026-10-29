import { describe, expect, it } from "vitest";
import { z } from "zod";
import { agentIds, inputFlags, loadAgent, parseCliArgs, usage } from "../src/index.ts";

const brief = {
  spec: { id: "brief-writer" },
  input: z.object({
    brief: z.string().trim().min(1),
    sports: z.array(z.string()).optional(),
    pages: z.number().default(10),
    draft: z.boolean().optional(),
    tenant: z.string().optional(),
    layout: z.object({ columns: z.number() }).optional(),
  }),
  cli: { flags: { sport: "sports" } },
};

describe("terminal runner", () => {
  it("gives each plain input field a flag, plus its aliases", () => {
    const flags = inputFlags(brief.input, brief.cli.flags);
    expect(Object.fromEntries(flags)).toEqual({
      brief: { field: "brief", kind: "string", required: true },
      sports: { field: "sports", kind: "strings", required: false },
      sport: { field: "sports", kind: "strings", required: false },
      pages: { field: "pages", kind: "number", required: false },
      draft: { field: "draft", kind: "boolean", required: false },
      // `tenant` is the runner's own flag and `layout` isn't plain: both go through --input
    });
  });

  it("turns the command line into the agent's input", () => {
    const args = parseCliArgs(brief as never, [
      "--tenant",
      "demo-cricket",
      "--brief",
      "A T20 club",
      "--sport",
      "cricket",
      "--sport",
      "kabaddi",
      "--pages",
      "12",
      "--input",
      '{"layout":{"columns":3}}',
    ]);
    expect(args).toEqual({
      tenant: "demo-cricket",
      fast: false,
      input: {
        brief: "A T20 club",
        sports: ["cricket", "kabaddi"],
        pages: 12,
        layout: { columns: 3 },
      },
    });
  });

  it("refuses a flag the agent doesn't take", () => {
    expect(() => parseCliArgs(brief as never, ["--tenant", "x", "--colour", "red"])).toThrow();
  });

  it("writes a usage line from the input", () => {
    expect(usage(brief as never, "pnpm brief")).toBe(
      "pnpm brief --tenant <id> --brief <brief> [--sport <sports>]... [--pages <pages>] [--draft] [--input <json>] [--fast]",
    );
  });

  it("finds the agents in agents/ by folder", async () => {
    expect(await agentIds()).toEqual(expect.arrayContaining(["match-preview", "sitemap"]));
    const sitemap = await loadAgent("sitemap");
    expect(sitemap.spec.id).toBe("sitemap");
    expect(usage(sitemap)).toBe(
      "pnpm agent sitemap --tenant <id> --brief <brief> [--sport <sports>]... [--input <json>] [--fast]",
    );
    expect(usage(await loadAgent("match-preview"), "pnpm preview")).toBe(
      "pnpm preview --tenant <id> --fixture <fixtureId> [--brief <brief>] [--input <json>] [--fast]",
    );
    await expect(loadAgent("nope")).rejects.toThrow('no agent "nope"');
  });
});
