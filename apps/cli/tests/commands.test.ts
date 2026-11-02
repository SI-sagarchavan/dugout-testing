import { agent as sitemap } from "@dugout/agent-sitemap";
import { describe, expect, it } from "vitest";
import {
  historyLine,
  isCommand,
  parseIntent,
  renderAgentHelp,
  renderHelp,
} from "../src/commands.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips the help screen's colour codes
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("commands", () => {
  it("opens the menu when nothing was passed", () => {
    expect(parseIntent([])).toEqual({ kind: "menu" });
  });

  it("knows help, version, and the command names", () => {
    expect(parseIntent(["--help"])).toEqual({ kind: "help" });
    expect(parseIntent(["-h"])).toEqual({ kind: "help" });
    expect(parseIntent(["help"])).toEqual({ kind: "help" });
    expect(parseIntent(["help", "attach"])).toEqual({ kind: "help", topic: "attach" });
    expect(parseIntent(["--version"])).toEqual({ kind: "version" });
    expect(parseIntent(["agents"])).toEqual({ kind: "agents" });
    expect(isCommand("runs")).toBe(true);
    expect(isCommand("sitemap")).toBe(false);
  });

  it("sends --help on a run to that agent", () => {
    expect(parseIntent(["sitemap", "--help"])).toEqual({ kind: "help", topic: "sitemap" });
    expect(parseIntent(["run", "sitemap", "--brief", "A club", "--help"])).toEqual({
      kind: "help",
      topic: "sitemap",
    });
    expect(parseIntent(["run", "--help"])).toEqual({ kind: "help", topic: "run" });
  });

  it("keeps the old run, attach, and cancel forms", () => {
    expect(parseIntent(["sitemap", "--tenant", "demo-cricket", "--brief", "A club"])).toEqual({
      kind: "run",
      agentId: "sitemap",
      argv: ["--tenant", "demo-cricket", "--brief", "A club"],
    });
    expect(parseIntent(["run", "sitemap", "--tenant", "demo-cricket"])).toEqual({
      kind: "run",
      agentId: "sitemap",
      argv: ["--tenant", "demo-cricket"],
    });
    expect(parseIntent(["run"])).toEqual({ kind: "run", argv: [] });
    expect(parseIntent(["--run", "abc", "--tenant", "demo-cricket", "--after", "4"])).toEqual({
      kind: "attach",
      run: "abc",
      tenant: "demo-cricket",
      after: "4",
    });
    expect(parseIntent(["attach", "abc", "--tenant", "demo-cricket"])).toEqual({
      kind: "attach",
      run: "abc",
      tenant: "demo-cricket",
    });
    expect(
      parseIntent(["--cancel", "abc", "--tenant", "demo-cricket", "--reason", "wrong fixture"]),
    ).toEqual({
      kind: "cancel",
      run: "abc",
      tenant: "demo-cricket",
      reason: "wrong fixture",
    });
    expect(parseIntent(["cancel", "--tenant", "demo-cricket"])).toEqual({
      kind: "cancel",
      tenant: "demo-cricket",
    });
    expect(parseIntent(["runs", "--tenant", "demo-cricket"])).toEqual({
      kind: "runs",
      tenant: "demo-cricket",
    });
    expect(parseIntent(["history", "abc", "--tenant", "demo-cricket"])).toEqual({
      kind: "history",
      run: "abc",
      tenant: "demo-cricket",
    });
    expect(parseIntent(["--history", "abc", "--tenant", "demo-cricket"])).toEqual({
      kind: "history",
      run: "abc",
      tenant: "demo-cricket",
    });
    expect(
      parseIntent(["fork", "abc", "--from", "4", "--tenant", "demo-cricket", "--model", "sonnet"]),
    ).toEqual({
      kind: "fork",
      run: "abc",
      from: "4",
      tenant: "demo-cricket",
      model: "sonnet",
    });
    expect(
      parseIntent(["--fork", "abc", "--from", "4", "--tenant", "demo-cricket", "--approve"]),
    ).toEqual({
      kind: "fork",
      run: "abc",
      from: "4",
      tenant: "demo-cricket",
      decision: { approved: true },
    });
    expect(parseIntent(["fork", "abc", "--reject", "wrong page"])).toEqual({
      kind: "fork",
      run: "abc",
      decision: { approved: false, reason: "wrong page" },
    });
  });

  it("refuses a fork that names two changes", () => {
    expect(
      parseIntent(["fork", "abc", "--from", "4", "--model", "sonnet", "--input", "{}"]),
    ).toMatchObject({ kind: "error" });
    expect(parseIntent(["fork", "--approve", "--reject", "no"])).toMatchObject({ kind: "error" });
  });

  it("rejects a flag it does not know", () => {
    expect(parseIntent(["--colour"])).toMatchObject({ kind: "error" });
    expect(parseIntent(["runs", "--colour"])).toMatchObject({ kind: "error" });
    expect(parseIntent(["agents", "--tenant", "demo-cricket"])).toMatchObject({ kind: "error" });
  });

  it("lists every command on the root help screen", () => {
    const help = plain(renderHelp());
    expect(help).toContain("dugout");
    expect(help).toContain("pnpm agent");
    for (const name of [
      "run <agent>",
      "attach [run]",
      "cancel [run]",
      "runs",
      "history [run]",
      "fork [run]",
      "agents",
    ]) {
      expect(help).toContain(name);
    }
    expect(help).toContain("memory <review|promote>");
    expect(help).toContain("y, n, or the change");
  });

  it("shows one command on its own", () => {
    const help = plain(renderHelp("cancel"));
    expect(help).toContain("pnpm agent cancel [run] --tenant <id> [--reason <why>]");
    expect(help).toContain("pnpm agent --cancel <run> --tenant <id> [--reason <why>]");
  });

  it("shows an agent's flags", () => {
    const help = plain(renderAgentHelp(sitemap));
    expect(help).toContain("sitemap");
    expect(help).toContain("pnpm agent sitemap --tenant <id> --brief <brief>");
    expect(help).toContain("--brief <brief>");
    expect(help).toContain("Required");
    expect(help).toContain("--input <json>");
  });

  it("prints a save point as one line", () => {
    const line = plain(
      historyLine({
        version: 4,
        step: 3,
        savedAfter: "waiting",
        messages: 8,
        waiting: { callId: "call-1", tool: "sitemap.build" },
        savedAt: "2026-10-30T12:00:00.000Z",
      }),
    );
    expect(line).toContain("4");
    expect(line).toContain("waiting");
    expect(line).toContain("step   3");
    expect(line).toContain("8 messages");
    expect(line).toContain("waiting on sitemap.build");
    expect(line).toContain("2026-10-30 12:00");
  });
});
