/**
 * What a picture's URLs answer, said so a plan can fix it. The run that found this bound
 * `…/players/{p.id}.png` from one photo's URL, and the site answered every id the data had with a
 * 68-byte PNG and a 200: a status alone said nothing was wrong.
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

  it("reports a URL that answers an error", () => {
    expect(pictureTrouble("a", [url("1")], [{ status: 404 }])).toMatch(
      /^a src loads nothing: .* answers 404/,
    );
  });

  it("reports the site's empty stand-in for an id it does not have", () => {
    expect(pictureTrouble("a", [url("10085")], [png(68, "x")])).toMatch(
      /^a src loads an empty picture: .* answers 68 bytes/,
    );
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

  it("reports the same picture for every item", () => {
    expect(
      pictureTrouble(
        "a",
        [url("1"), url("2"), url("3")],
        [png(4_000, "same"), png(4_000, "same"), png(4_000, "same")],
      ),
    ).toMatch(/^a src draws the same picture for every item/);
  });

  it("reports a page where a picture should be", () => {
    expect(
      pictureTrouble(
        "a",
        [url("1")],
        [{ status: 200, type: "text/html", bytes: 9_000, digest: "p" }],
      ),
    ).toMatch(/loads a text\/html page/);
  });

  it("says nothing when the site could not be reached", () => {
    expect(pictureTrouble("a", [url("1")], [undefined])).toBeUndefined();
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
