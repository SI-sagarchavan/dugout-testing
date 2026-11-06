import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_TOOLS, EVAL_TOOLS } from "../src/tool-tables.ts";
import { resolveTool, subcommandsOf } from "../src/tools.ts";

describe("tools", () => {
  it("finds a one-word tool and passes the rest on", () => {
    const hit = resolveTool(AGENT_TOOLS, ["watch", "--tenant", "demo-cricket"]);
    expect(hit?.file.endsWith("apps/cli/scripts/figma-watch.ts")).toBe(true);
    expect(hit?.args).toEqual(["--tenant", "demo-cricket"]);
  });

  it("finds a two-word tool", () => {
    const hit = resolveTool(AGENT_TOOLS, ["memory", "review", "--shared"]);
    expect(hit?.file.endsWith("packages/memory/scripts/review.ts")).toBe(true);
    expect(hit?.args).toEqual(["--shared"]);
  });

  it("leaves an agent id and the host's own commands to the host", () => {
    expect(resolveTool(AGENT_TOOLS, ["sitemap", "--tenant", "t"])).toBeUndefined();
    expect(resolveTool(AGENT_TOOLS, ["attach", "--run", "r"])).toBeUndefined();
    expect(resolveTool(AGENT_TOOLS, [])).toBeUndefined();
  });

  it("lists what follows a group word", () => {
    expect(subcommandsOf(AGENT_TOOLS, "memory").sort()).toEqual(["answers", "promote", "review"]);
    expect(subcommandsOf(AGENT_TOOLS, "watch")).toEqual([]);
  });

  it("points every tool at a script that exists", () => {
    for (const table of [AGENT_TOOLS, EVAL_TOOLS]) {
      for (const key of Object.keys(table)) {
        const hit = resolveTool(table, key.split(" "));
        expect(hit && existsSync(hit.file), key).toBe(true);
      }
    }
  });
});
