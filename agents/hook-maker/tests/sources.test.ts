import { describe, expect, it } from "vitest";
import { Need, parseSources, RunInput } from "../src/agent.ts";

const SQUAD = "https://www.southernbrave.com/cricket/v2/series/squad";
const WOMEN = `${SQUAD}?team_id=2034&series_id=15399&lang=en&feed_format=json&client_id=4ab1ce0f`;
const MEN = `${SQUAD}?team_id=2042&series_id=15397&lang=en&feed_format=json&client_id=4ab1ce0f`;

const need = {
  list: "players",
  count: "data" as const,
  item: [{ field: "player name", required: true }],
};

describe("need.sources: the feeds a person gave", () => {
  it("reads a person's answer, one labelled URL per line", () => {
    expect(parseSources(`women: ${WOMEN}\nmen - ${MEN}\n`)).toEqual([
      { label: "women", url: WOMEN },
      { label: "men", url: MEN },
    ]);
  });

  it("takes a bare URL as a feed, drops lines with none and repeated URLs", () => {
    expect(parseSources(`here you go\n${WOMEN}\nWomen: ${WOMEN}\nnot a link: ftp://x`)).toEqual([
      { label: "feed", url: WOMEN },
    ]);
    expect(parseSources("")).toEqual([]);
  });

  it("is a field of the need that hook-maker is called with, both feeds kept", () => {
    const sources = parseSources(`women: ${WOMEN}\nmen: ${MEN}`);
    const call = RunInput.parse({ need: { ...need, sources } });
    expect(call.need.sources).toEqual([
      { label: "women", url: WOMEN },
      { label: "men", url: MEN },
    ]);
    // a source without a label, or a label that is not a URL, is refused
    expect(Need.safeParse({ ...need, sources: [{ label: "", url: WOMEN }] }).success).toBe(false);
    expect(Need.safeParse({ ...need, sources: [{ label: "men", url: "men" }] }).success).toBe(
      false,
    );
  });

  it("tells the model that 'data' is the count for whatever the data holds", () => {
    expect(Need.safeParse({ ...need, count: 0 }).success).toBe(false);
    const described = Need.shape.count.description;
    expect(described).toContain('"data" is the value for whatever the data holds');
  });
});
