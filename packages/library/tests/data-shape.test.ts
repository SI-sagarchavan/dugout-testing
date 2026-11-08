import { describe, expect, it } from "vitest";
import { type BindingPlan, dataShapeOf, shapeWords } from "../src/index.ts";

// as data-bind bound sb's news section: the big card by position, the four small ones as two
// collapses over the rest of the list
const plan: BindingPlan = {
  bind: [
    { path: "news.articles.0.image", prop: "src", src: "big;img" },
    { path: "news.articles.0.title", prop: "content", src: "big;title" },
    { path: "news.articles.0.read_time", prop: "content", src: "big;time" },
    {
      path: 'news.articles.0.published_date | date:"DD MMM, YYYY"',
      prop: "content",
      src: "big;date",
    },
  ],
  collapse: [
    {
      over: "news.articles",
      as: "a",
      members: ["c1", "c2"],
      slice: [1, 3],
      fields: [
        { path: "image", prop: "src", src: "c1;img" },
        { path: "title", prop: "content", src: "c1;title" },
        { path: 'published_date | date:"DD MMM, YYYY"', prop: "content", src: "c1;date" },
      ],
    },
    {
      over: "news.articles",
      as: "b",
      members: ["c3", "c4"],
      slice: [3, 5],
      fields: [{ path: "title", prop: "content", src: "c3;title" }],
    },
  ],
};
const article = (title: string) => ({
  image: "https://cdn.example/a.jpg",
  title,
  read_time: "1",
  published_date: "2026-10-23T12:13:50.747Z",
});
const data = { news: { articles: ["One", "Two", "Three", "Four", "Five"].map(article) } };
const all = () => true;

describe("dataShapeOf", () => {
  it("keeps the fields and how many items the design draws, and no value", () => {
    const shape = dataShapeOf({ plan, data, within: all });
    expect(shape).toEqual({
      lists: [
        {
          path: "news.articles",
          items: 5,
          looks: 1,
          fields: [
            { path: "image", type: "image" },
            { path: "title", type: "text" },
            { path: "read_time", type: "number" },
            { path: "published_date", type: "datetime", format: 'date:"DD MMM, YYYY"' },
          ],
        },
      ],
      fields: [],
    });
    expect(JSON.stringify(shape)).not.toMatch(/One|Two|cdn\.example|2026-10-23/);
    expect(shapeWords(shape as NonNullable<typeof shape>)).toBe(
      "Data: a list of 5 news articles, each with image (picture), title (text), read time (number), published date (date).",
    );
  });

  it("reads only what is inside the section", () => {
    const shape = dataShapeOf({ plan, data, within: (src) => src.startsWith("c3") });
    expect(shape?.lists).toEqual([
      { path: "news.articles", items: 5, looks: 1, fields: [{ path: "title", type: "text" }] },
    ]);
    expect(dataShapeOf({ plan, data, within: () => false })).toBeUndefined();
  });

  it("resolves a list inside an outer list's item, templates, variants and top-level fields", () => {
    const nested: BindingPlan = {
      bind: [{ path: "fixtures.title", prop: "content", src: "h" }],
      collapse: [
        {
          over: "day.matches",
          as: "match",
          members: ["m1", "m2", "m3"],
          fields: [
            { template: "({match.overs} ov) {day.label}", prop: "content", src: "m1;o" },
            { path: "home.crest", prop: "src", src: "m1;c" },
            { path: "live", prop: "content", src: "m1;l" },
          ],
          variants: [{ src: "m2", fields: [{ path: "result", prop: "content", src: "m2;r" }] }],
        },
        { over: "fixtures.days", as: "day", members: ["d1", "d2"] },
      ],
    };
    const fixtures = {
      fixtures: {
        title: "Fixtures",
        days: [
          {
            label: "Sat",
            matches: [{ overs: 20, home: { crest: null }, live: true, result: "W" }],
          },
        ],
      },
    };
    expect(dataShapeOf({ plan: nested, data: fixtures, within: all })).toEqual({
      lists: [
        {
          path: "fixtures.days[].matches",
          items: 3,
          looks: 2,
          fields: [
            { path: "overs", type: "number" },
            { path: "home.crest", type: "image" },
            { path: "live", type: "boolean" },
            { path: "result", type: "text" },
          ],
        },
        // the template's {day.label} is the outer item's
        { path: "fixtures.days", items: 2, looks: 1, fields: [{ path: "label", type: "text" }] },
      ],
      fields: [{ path: "fixtures.title", type: "text" }],
    });
  });
});
