import { agentIds, loadAgent } from "@dugout/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { inputFields, inputFlags, parseCliArgs, usage } from "../src/flags.ts";

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

describe("command line", () => {
  it("gives each plain input field a flag, plus its aliases", () => {
    const flags = inputFlags(brief.input, brief.cli.flags);
    expect(Object.fromEntries(flags)).toEqual({
      brief: { field: "brief", kind: "string", required: true },
      sports: { field: "sports", kind: "strings", required: false },
      sport: { field: "sports", kind: "strings", required: false },
      pages: { field: "pages", kind: "number", required: false },
      draft: { field: "draft", kind: "boolean", required: false },
      // `tenant` is the CLI's own flag and `layout` isn't plain: both go through --input
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
      model: undefined,
      effort: undefined,
      yes: false,
      input: {
        brief: "A T20 club",
        sports: ["cricket", "kabaddi"],
        pages: 12,
        layout: { columns: 3 },
      },
    });
  });

  it("reads the model and effort a run asks for", () => {
    const args = parseCliArgs(brief as never, [
      "--tenant",
      "demo-cricket",
      "--brief",
      "A T20 club",
      "--model",
      "haiku",
      "--effort",
      "high",
    ]);
    expect(args).toMatchObject({ model: "haiku", effort: "high" });
    expect(args.input).toEqual({ brief: "A T20 club" });
  });

  it("shows them in the usage line", () => {
    expect(usage(brief as never)).toContain("[--model <name>] [--effort <level>] [--yes]");
  });

  it("refuses a flag the agent doesn't take", () => {
    expect(() => parseCliArgs(brief as never, ["--tenant", "x", "--colour", "red"])).toThrow();
  });

  it("keeps a description and enum options for prompts and help", () => {
    const fields = inputFields(
      z.object({
        format: z.enum(["T20", "ODI"]).describe("Match format"),
        tags: z.array(z.enum(["news", "squad"])).optional(),
        note: z.string().optional(),
      }),
    );
    expect(fields).toEqual([
      {
        field: "format",
        flag: "format",
        names: ["format"],
        kind: "string",
        required: true,
        description: "Match format",
        options: ["T20", "ODI"],
      },
      {
        field: "tags",
        flag: "tags",
        names: ["tags"],
        kind: "strings",
        required: false,
        options: ["news", "squad"],
      },
      { field: "note", flag: "note", names: ["note"], kind: "string", required: false },
    ]);
  });

  it("writes a usage line from the input", () => {
    expect(usage(brief as never, "pnpm brief")).toBe(
      "pnpm brief --tenant <id> --brief <brief> [--sport <sports>]... [--pages <pages>] [--draft] [--input <json>] [--model <name>] [--effort <level>] [--yes]",
    );
  });

  it("finds the agents in agents/ by folder", async () => {
    expect(await agentIds()).toEqual(expect.arrayContaining(["card-match", "sitemap"]));
    const sitemap = await loadAgent("sitemap");
    expect(sitemap.spec.id).toBe("sitemap");
    expect(usage(sitemap)).toBe(
      "pnpm agent sitemap --tenant <id> --brief <brief> [--sport <sports>]... [--input <json>] [--model <name>] [--effort <level>] [--yes]",
    );
    await expect(loadAgent("nope")).rejects.toThrow('no agent "nope"');
  });
});
