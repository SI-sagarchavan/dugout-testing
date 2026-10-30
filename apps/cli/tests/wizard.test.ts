import { loadTenants } from "@dugout/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Choice, Prompter } from "../src/ui.ts";
import { completeInput, fieldSuggestions, TYPE_A_VALUE } from "../src/wizard.ts";

interface Call {
  type: string;
  message: string;
}

/** Answers prompts in order and records what was asked. */
function scripted(answers: unknown[]) {
  const calls: Call[] = [];
  const take = (type: string, message: string) => {
    calls.push({ type, message });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`no answer for ${type}: ${message}`);
    return answer;
  };
  const prompter: Prompter = {
    select: (message) => Promise.resolve(take("select", message) as string),
    multiselect: (message) => Promise.resolve(take("multiselect", message) as string[]),
    text: (message) => Promise.resolve(take("text", message) as string),
    multiline: (message) => Promise.resolve(take("multiline", message) as string),
    confirm: (message) => Promise.resolve(take("confirm", message) as boolean),
  };
  return { calls, prompter };
}

const none = (): readonly Choice[] => [];

describe("input prompts", () => {
  it("returns flags already given, and does not ask again", async () => {
    const { calls, prompter } = scripted([]);
    const input = await completeInput({
      agent: { input: z.object({ fixtureId: z.string(), brief: z.string().optional() }), cli: {} },
      given: { fixtureId: "c-101" },
      askOptional: false,
      suggestions: none,
      prompter,
    });
    expect(input).toEqual({ fixtureId: "c-101" });
    expect(calls).toEqual([]);
  });

  it("offers known values, and a way to type one", async () => {
    const { calls, prompter } = scripted([TYPE_A_VALUE, "c-999"]);
    const input = await completeInput({
      agent: {
        input: z.object({ fixtureId: z.string() }),
        cli: { flags: { fixture: "fixtureId" } },
      },
      given: {},
      askOptional: false,
      suggestions: () => [{ value: "c-101", label: "c-101", hint: "opener" }],
      prompter,
    });
    expect(calls.map((call) => call.type)).toEqual(["select", "text"]);
    expect(calls[0]?.message).toBe("Fixture id");
    expect(input).toEqual({ fixtureId: "c-999" });
  });

  it("asks for a brief on several lines, then offers optional fields", async () => {
    const { calls, prompter } = scripted(["A T20 club.", ["draft"], true]);
    const input = await completeInput({
      agent: {
        input: z.object({
          brief: z.string(),
          draft: z.boolean().optional(),
        }),
        cli: {},
      },
      given: {},
      askOptional: true,
      suggestions: none,
      prompter,
    });
    expect(calls.map((call) => `${call.type}:${call.message}`)).toEqual([
      "multiline:Brief",
      "multiselect:Set anything else?",
      "confirm:Draft",
    ]);
    expect(input).toEqual({ brief: "A T20 club.", draft: true });
  });

  it("uses enum options and splits a typed list", async () => {
    const { prompter } = scripted(["T20", "news, squad"]);
    const input = await completeInput({
      agent: {
        input: z.object({
          format: z.enum(["T20", "ODI"]),
          tags: z.array(z.string()),
        }),
        cli: {},
      },
      given: {},
      askOptional: false,
      suggestions: none,
      prompter,
    });
    expect(input).toEqual({ format: "T20", tags: ["news", "squad"] });
  });

  it("suggests a tenant's sports and its fixtures", () => {
    const cricket = loadTenants().require("demo-cricket");
    expect(fieldSuggestions(cricket, "sports")).toEqual([{ value: "cricket", label: "cricket" }]);
    const opener = fieldSuggestions(cricket, "fixtureId").find(
      (choice) => choice.value === "c-101",
    );
    expect(opener?.hint).toContain("Mumbai Mariners");
    expect(opener?.hint).toContain("Wankhede Arena");
    expect(fieldSuggestions(cricket, "brief")).toEqual([]);
  });
});
