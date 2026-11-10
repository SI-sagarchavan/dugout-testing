import { describe, expect, it } from "vitest";
import {
  clockScope,
  clockTick,
  clockValues,
  evaluateWhen,
  parseInstant,
  resolveTemplate,
  validate,
} from "../src/index.js";
import { registry } from "./helpers.js";

const KICKOFF = "2026-11-17T14:30:00+00:00";
const at = (iso: string) => Date.parse(iso);

describe("a clock", () => {
  it("counts down in the units the design draws", () => {
    const now = at("2026-11-15T12:17:27Z"); // 2d 2h 12m 33s before
    expect(clockValues(["d", "h", "m", "s"], at(KICKOFF), now)).toEqual({
      d: 2,
      h: 2,
      m: 12,
      s: 33,
      past: false,
      total: 2 * 86_400 + 2 * 3_600 + 12 * 60 + 33,
    });
  });

  it("puts what the design does not draw into the largest unit it does", () => {
    const now = at("2026-11-15T12:17:27Z");
    expect(clockValues(["h", "m"], at(KICKOFF), now)).toMatchObject({ h: 50, m: 12 });
    expect(clockValues(["h", "m"], at(KICKOFF), now).d).toBeUndefined();
  });

  it("counts up once the instant has gone, and says so", () => {
    const now = at("2026-11-17T14:42:05Z");
    expect(clockValues(["m", "s"], at(KICKOFF), now)).toMatchObject({ m: 12, s: 5, past: true });
  });

  it("reads its instant from the data, in the node's scope", () => {
    const scope = { match: { start_time: KICKOFF } };
    const now = at("2026-11-16T14:30:00Z");
    const clock = clockScope({ to: "{match.start_time}", as: "countdown", units: ["d", "h"] }, scope, now);
    expect(clock).toMatchObject({ as: "countdown", units: ["d", "h"], values: { d: 1, h: 0, past: false } });
    expect(clockScope({ to: "{match.nothing}" }, scope, now)?.values).toBeUndefined();
    expect(clockScope({ to: 5 as unknown as string, units: [] }, scope, now)).toBeUndefined();
  });

  it("reads an ISO time with no offset as UTC, so server and browser agree", () => {
    expect(parseInstant("2026-11-17T14:30:00")).toBe(at("2026-11-17T14:30:00Z"));
    expect(parseInstant("not a date")).toBeUndefined();
  });

  it("ticks once per its smallest unit", () => {
    expect(clockTick(["d", "h", "m", "s"])).toBe(1000);
    expect(clockTick(["d", "h"])).toBe(3_600_000);
  });

  it("is bound like any data: digits padded as drawn, a when on past", () => {
    const now = at("2026-11-17T14:29:51Z");
    const countdown = clockValues(["d", "h", "m", "s"], at(KICKOFF), now);
    expect(resolveTemplate("{countdown.d | pad:2}:{countdown.s | pad:2}", { countdown }).value).toBe("00:09");
    expect(evaluateWhen({ path: "countdown.past", eq: false }, { countdown })).toBe(true);
    expect(evaluateWhen({ path: "countdown.d", gt: 0 }, { countdown })).toBe(false);
  });

  it("is a prop any node may carry", () => {
    const clock: { to: string; as: string; units: string[] } = {
      to: "{match.start_time}",
      as: "countdown",
      units: ["d", "h", "m", "s"],
    };
    const tree = {
      schemaVersion: "1.0.0",
      nodes: [
        {
          id: "root",
          parent: null,
          idx: 0,
          type: "Stack",
          src: "1:1",
          props: { clock },
        },
        { id: "t", parent: "root", idx: 0, type: "Text", src: "1:2", props: { content: "{countdown.d | pad:2}", style: "type.body_md_bold" } },
      ],
    };
    const issues = (data: unknown) => {
      const result = validate(tree as never, { registry: registry(), data });
      return [...result.errors, ...result.warnings];
    };
    expect(issues({ match: { start_time: "2026-11-17T14:30:00+00:00" } })).toEqual([]);
    // a unit the clock does not draw is not in scope
    clock.units = ["h", "m"];
    expect(issues({ match: { start_time: "2026-11-17T14:30:00+00:00" } }).map((i) => i.code)).toEqual(["B1"]);
    clock.units = ["d"];
    expect(issues({ match: { start_time: "soon" } }).map((i) => i.message)).toEqual([
      "clock.to {match.start_time}: the sample values are not dates or times the clock can read",
    ]);
  });
});

describe("the pad pipe", () => {
  it("pads whole numbers and leaves anything else alone", () => {
    expect(resolveTemplate("{n | pad:2}", { n: 7 }).value).toBe("07");
    expect(resolveTemplate("{n | pad:2}", { n: 123 }).value).toBe("123");
    expect(resolveTemplate("{n | pad:3}", { n: "4" }).value).toBe("004");
    expect(resolveTemplate("{n | pad:2}", { n: "4.5" }).value).toBe("4.5");
  });
});
