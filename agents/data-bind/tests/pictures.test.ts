/**
 * What a picture's URLs answer. An error or a page shows broken and is fixed; a tiny picture, or
 * the same bytes for every item, is reported as heard and a keep with why takes it: a site may
 * answer an id it lacks with a stand-in, and one logo on every item is right as often. The run
 * that found this bound `…/players/{p.id}.png` from one photo's URL, and the site answered every
 * id the data had with a 68-byte PNG and a 200.
 */
import { describe, expect, it } from "vitest";
import { pictureTrouble } from "../src/tools.ts";

const url = (id: string) => `https://www.example.com/players/${id}.png`;
const png = (bytes: number, digest: string) => ({ status: 200, type: "image/png", bytes, digest });

describe("pictureTrouble", () => {
  it("says nothing of pictures that load, each its own", () => {
    expect(
      pictureTrouble("a", [url("1"), url("2")], [png(60_000, "x"), png(58_000, "y")]),
    ).toBeUndefined();
  });

  it("reports a URL that answers an error, to be fixed", () => {
    const found = pictureTrouble("a", [url("1")], [{ status: 404 }]);
    expect(found?.message).toMatch(/^a src loads nothing: .* answers 404/);
    expect(found?.keep).toBeUndefined();
  });

  it("reports a tiny picture as what was heard, which a keep with why takes", () => {
    const found = pictureTrouble("a", [url("10085")], [png(68, "x")]);
    expect(found?.message).toMatch(/^a src answers a 68-byte image\/png at /);
    expect(found).toMatchObject({ src: "a", keep: true });
  });

  it("says nothing of a small SVG icon, which may be whole", () => {
    expect(
      pictureTrouble(
        "a",
        [url("1")],
        [{ status: 200, type: "image/svg+xml", bytes: 150, digest: "s" }],
      ),
    ).toBeUndefined();
  });

  it("reports the same bytes for every item as an observation: one logo for all may be right", () => {
    const found = pictureTrouble(
      "a",
      [url("1"), url("2"), url("3")],
      [png(4_000, "same"), png(4_000, "same"), png(4_000, "same")],
    );
    expect(found?.message).toMatch(/^a src answers the same bytes for 3 items' URLs/);
    expect(found).toMatchObject({ src: "a", keep: true });
  });

  it("reports a page where a picture should be, to be fixed", () => {
    const found = pictureTrouble(
      "a",
      [url("1")],
      [{ status: 200, type: "text/html", bytes: 9_000, digest: "p" }],
    );
    expect(found?.message).toMatch(/loads a text\/html, not a picture/);
    expect(found?.keep).toBeUndefined();
  });

  it("says so when no URL answered at all, as an observation a keep can accept", () => {
    const problem = pictureTrouble("a", [url("1"), url("2")], [undefined, undefined]);
    expect(problem).toMatchObject({ src: "a", keep: true });
    expect(problem?.message).toContain("got no answer from 2 item URL(s)");
    // one answered: what it answered is judged, the silent one is not a finding
    expect(
      pictureTrouble(
        "a",
        [url("1"), url("2")],
        [undefined, { status: 200, type: "image/png", bytes: 9000, digest: "x" }],
      ),
    ).toBeUndefined();
  });
});

import { lostLooks } from "../src/facts.ts";

describe("lostLooks", () => {
  const tree = {
    schemaVersion: "1.0.0",
    nodes: [
      { id: "list", src: "list", parent: null, idx: 0, type: "Stack", props: {} },
      ...[0, 1, 2].map((i) => ({
        id: `row${i}`,
        src: `row${i}`,
        parent: "list",
        idx: i,
        type: "Stack",
        props: i < 2 ? { surface: "surface.ruled" } : {},
      })),
    ],
  };

  it("reports a look the fold would lose", () => {
    expect(lostLooks(tree as never, ["row0", "row1", "row2"])).toHaveLength(1);
  });

  it("not one the fold keeps by place", () => {
    expect(lostLooks(tree as never, ["row0", "row1", "row2"], new Set(["row0"]))).toEqual([]);
  });
});
