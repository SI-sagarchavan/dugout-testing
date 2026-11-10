import { describe, expect, it } from "vitest";
import { basisOf } from "../src/agent.ts";
import { wrongEntity } from "../src/entity.ts";
import { planFeeds } from "../src/feeds.ts";

const base = "https://www.example-club.com/cricket";

describe("feeds a person gave become providers and connectors, by code (ticket 17)", () => {
  it("gives one origin one provider whose base is the origin, the whole path in each connector", () => {
    const { providers } = planFeeds([
      { label: "squad", url: `${base}/v2/series/squad?team_id=1` },
      { label: "table", url: `${base}/v1/series/standings?series_id=9` },
    ]);
    expect(providers).toHaveLength(1);
    expect(providers[0]).toMatchObject({
      origin: "https://www.example-club.com",
      baseUrl: "https://www.example-club.com",
      name: "dugout: www.example-club.com",
    });
    expect(providers[0]?.connectors.map((c) => c.url)).toEqual([
      "{{env.base_url}}/cricket/v2/series/squad",
      "{{env.base_url}}/cricket/v1/series/standings",
    ]);
  });

  it("plans a lone feed and two feeds of one path on the same base: reuse by origin finds it", () => {
    const news = "https://news.example.org/api/v3/articles";
    const one = planFeeds([{ label: "latest", url: `${news}?tag=club` }]);
    const two = planFeeds([
      { label: "club", url: `${news}?tag=club` },
      { label: "academy", url: `${news}?tag=academy` },
    ]);
    expect(one.providers[0]?.baseUrl).toBe("https://news.example.org");
    expect(two.providers[0]?.baseUrl).toBe("https://news.example.org");
    expect(one.providers[0]?.connectors[0]?.url).toBe("{{env.base_url}}/api/v3/articles");
    expect(two.providers[0]?.connectors[0]?.url).toBe("{{env.base_url}}/api/v3/articles");
    expect(two.providers[0]?.connectors[0]?.queryParams).toEqual([
      { key: "tag", value: "{{input.tag}}" },
    ]);
  });

  it("makes feeds that differ only in their query one connector, the differing parameters inputs", () => {
    const { providers } = planFeeds([
      { label: "women", url: `${base}/v2/squad?team_id=2034&series_id=1&client_id=abc` },
      { label: "men", url: `${base}/v2/squad?team_id=2042&series_id=2&client_id=abc` },
    ]);
    const [connector] = providers[0]?.connectors ?? [];
    expect(providers[0]?.connectors).toHaveLength(1);
    expect(connector?.queryParams).toEqual([
      { key: "team_id", value: "{{input.team_id}}" },
      { key: "series_id", value: "{{input.series_id}}" },
      { key: "client_id", value: "abc" },
    ]);
    expect(connector?.calls).toEqual([
      { label: "women", url: expect.any(String), input: { team_id: "2034", series_id: "1" } },
      { label: "men", url: expect.any(String), input: { team_id: "2042", series_id: "2" } },
    ]);
  });

  it("splits origins into providers, keeps a trailing slash, and refuses what is not an http(s) URL", () => {
    const { providers } = planFeeds([
      { label: "a", url: "https://a.test/api/v3/fixtures?x=1" },
      { label: "b", url: "http://b.test/list" },
      { label: "c", url: "http://b.test/list/" },
    ]);
    expect(providers.map((p) => p.baseUrl)).toEqual(["https://a.test", "http://b.test"]);
    expect(providers[0]?.connectors[0]?.url).toBe("{{env.base_url}}/api/v3/fixtures");
    expect(providers[1]?.connectors.map((c) => c.url)).toEqual([
      "{{env.base_url}}/list",
      "{{env.base_url}}/list/",
    ]);
    const out = planFeeds([
      { label: "x", url: "not a url" },
      { label: "y", url: "ftp://h.test/a" },
    ]);
    expect(out.providers).toEqual([]);
    expect(out.refused).toHaveLength(2);
  });

  it("refuses a URL with credentials in it, and never repeats the password", () => {
    const out = planFeeds([
      { label: "videos", url: "https://user:hunter2@media.example.net/v1/clips" },
    ]);
    expect(out.providers).toEqual([]);
    expect(out.refused[0]).toContain("user name or password");
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("never plans a secret as a literal: it is a credential, reported for a person to add", () => {
    const KEY = "sk_live_REDACTED";
    const out = planFeeds([
      { label: "table", url: `https://stats.example.com/v2/standings?league=7&api_key=${KEY}` },
      { label: "events", url: `https://events.example.com/feed?sig=${"a1".repeat(16)}&city=leeds` },
      { label: "clips", url: `https://media.example.net/clips?t=Zx9Qm2Lp8Rt4Vb6Nc1Kd7Hs3` },
    ]);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain("a1a1a1");
    expect(JSON.stringify(out)).not.toContain("Zx9Qm2Lp8Rt4Vb6Nc1Kd7Hs3");
    expect(out.providers[0]?.connectors[0]?.queryParams).toEqual([
      { key: "league", value: "7" },
      { key: "api_key", value: "{{cred.api_key}}" },
    ]);
    expect(out.secrets.map((s) => [s.key, s.cred, s.labels])).toEqual([
      ["api_key", "api_key", ["table"]],
      ["sig", "sig", ["events"]],
      ["t", "t", ["clips"]],
    ]);
    // an id is not a secret
    expect(planFeeds([{ label: "x", url: `${base}/squad?client_id=4ab1ce0f` }]).secrets).toEqual(
      [],
    );
  });

  it("keeps repeated parameters, makes names safe, and keeps values encoded", () => {
    const { providers } = planFeeds([
      { label: "news", url: "https://news.example.org/list?id=1&id=2&f[t]=a%20b&q=caf%C3%A9" },
      { label: "videos", url: "https://news.example.org/list?id=3&id=4&f[t]=c&q=caf%C3%A9" },
    ]);
    const [connector] = providers[0]?.connectors ?? [];
    expect(connector?.queryParams).toEqual([
      { key: "id", value: "{{input.id}}" },
      { key: "id", value: "{{input.id_2}}" },
      { key: "f[t]", value: "{{input.f_t}}" },
      { key: "q", value: "caf%C3%A9" },
    ]);
    expect(connector?.calls.map((c) => c.input)).toEqual([
      { id: "1", id_2: "2", f_t: "a%20b" },
      { id: "3", id_2: "4", f_t: "c" },
    ]);
  });

  it("makes a parameter only one feed has an override of that feed's call, not an empty input of the other's", () => {
    const { providers } = planFeeds([
      { label: "results", url: "https://events.example.com/feed?city=leeds&past=1" },
      { label: "upcoming", url: "https://events.example.com/feed?city=leeds" },
    ]);
    const [connector] = providers[0]?.connectors ?? [];
    expect(connector?.queryParams).toEqual([
      { key: "city", value: "leeds" },
      { key: "past", value: "{{input.past}}" },
    ]);
    expect(connector?.calls.map((c) => c.input)).toEqual([{ past: "1" }, {}]);
  });
});

describe("the entity check follows how the data came (ticket 17)", () => {
  const squad = { players: [{ name: "Sophie Devine" }, { name: "Alex Hales" }] };
  const other = { players: [{ name: "Glenn Maxwell", team: "Punjab Kings" }] };
  const must = { team: "Southern Brave" };

  it("does not fault a person's feed that names no team, and faults one naming another", () => {
    expect(wrongEntity(squad, must, { trusted: true })).toBeUndefined();
    expect(wrongEntity(other, must, { trusted: true })).toContain("Punjab Kings");
    // a hook the agent found has to name the team somewhere
    expect(wrongEntity(squad, must)).toContain("nothing in the data names the team");
    expect(wrongEntity({ team: "Southern Brave" }, must, { trusted: true })).toBeUndefined();
  });

  it("derives the basis from the run, not the model", () => {
    const answer = (built: boolean, hookId = "dugout_x") =>
      ({ hookId, built, missing: [], covers: [], why: "", input: {} }) as never;
    const need = (extra: object) => ({ need: { list: "l", count: "data", item: [], ...extra } });
    expect(
      basisOf(answer(true), need({ sources: [{ label: "a", url: "https://x.test/a" }] })),
    ).toBe("sources");
    expect(basisOf(answer(false), need({ hook: "dugout_x" }))).toBe("chosen");
    expect(basisOf(answer(true), need({}))).toBe("built");
    expect(basisOf(answer(false), need({}))).toBe("found");
  });
});

describe("a must held by whole words, short names and initials (ticket 09 review)", async () => {
  const { holdsWords } = await import("../src/entity.ts");
  it("matches initials, a short name and the whole name", () => {
    expect(holdsWords("Kolkata Knight Riders won by 5 wickets", "KKR")).toBe(true);
    expect(holdsWords("KKR v MI", "Kolkata Knight Riders")).toBe(true);
    expect(holdsWords("Southern Brave", "Brave")).toBe(true);
    expect(holdsWords("The Brave beat the Spirit", "Southern Brave")).toBe(true);
    expect(holdsWords("Leeds Rhinos v Wigan Warriors", "Leeds Rhinos")).toBe(true);
  });

  it("does not match inside a word, or a short name another name owns", () => {
    expect(holdsWords("Current error", "RR")).toBe(false);
    expect(holdsWords("Atlanta Braves", "Brave")).toBe(false);
    expect(holdsWords("Newcastle United 2-1", "Manchester United")).toBe(false);
    expect(holdsWords("Atlanta Brave", "Southern Brave")).toBe(false);
  });
});

describe("a found hook on a person's feeds is theirs (ticket 17 review)", () => {
  const FEED = "https://media.example.net/v1/clips?channel=7";
  const described = (url: string, overrides: string) => [
    {
      role: "assistant" as const,
      content: "",
      toolCalls: [{ id: "c1", name: "cast.describeHook", arguments: '{"hookId":"dugout_clips"}' }],
    },
    {
      role: "tool" as const,
      toolCallId: "c1",
      content: `HOOK  dugout_clips\nSTEPS\n  n1  apiCall\n      api: "dugout: clips" (api_1)\n      GET {{env.base_url}}${url}\n      provider: "dugout: media.example.net" — base https://media.example.net\n      overrides: ${overrides}\n\n  n2  transformer\n      transform: whole-mode`,
    },
  ];
  const answer = {
    hookId: "dugout_clips",
    built: false,
    missing: [],
    covers: [],
    why: "",
    input: {},
  };
  const need = {
    need: { list: "clips", count: "data", item: [], sources: [{ label: "clips", url: FEED }] },
  };

  it("is sources when its step calls the feed's endpoint with the feed's values", async () => {
    const { basisOf, callsSources } = await import("../src/agent.ts");
    expect(basisOf(answer as never, need, described("/v1/clips", "channel=7"))).toBe("sources");
    expect(
      callsSources(described("/v1/clips", "channel={{input.channel}}"), "dugout_clips", [
        { label: "c", url: FEED },
      ]),
    ).toBe(true);
    // another endpoint, or another channel, is a hook the agent found
    expect(basisOf(answer as never, need, described("/v1/live", "channel=7"))).toBe("found");
    expect(basisOf(answer as never, need, described("/v1/clips", "channel=9"))).toBe("found");
  });
});
