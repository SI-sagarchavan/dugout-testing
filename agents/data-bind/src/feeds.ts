/**
 * A club's feeds, known once (`.scratch/data-sources/issues/07`). A house fact whose key is
 * `feed.<kind>.<label>` gives one feed: `feed.squad.women` is the women's squad,
 * `feed.squad.men` the men's. The fact's text holds the URL, query included. hook-maker builds on
 * them as `need.sources` before a person is asked for one.
 */
export interface Feed {
  /** What it gives: squad, schedule, standings, stats. */
  kind: string;
  /** The part of the design it is for: women, men; the competition when a club has several. */
  label: string;
  url: string;
}

const KEY = /^feed\.([a-z0-9-]+)\.([a-z0-9-]+)$/;

/** The feeds among a tenant's active facts. A fact with no URL in it is not a feed. */
export function feedsOf(facts: ReadonlyArray<{ key: string | null; content: string }>): Feed[] {
  return facts.flatMap((fact) => {
    const key = fact.key ? KEY.exec(fact.key) : null;
    const url = /https?:\/\/[^\s"'<>]+/.exec(fact.content)?.[0];
    return key?.[1] && key[2] && url ? [{ kind: key[1], label: key[2], url }] : [];
  });
}

/**
 * Who the club is, from its house facts: `club.team` (and `club.competition`). What a design on
 * the club's site is about unless it says otherwise, so the data is checked against it even when
 * the model leaves `about` out.
 */
export function clubAbout(facts: ReadonlyArray<{ key: string | null; content: string }>): {
  team?: string;
  competition?: string;
} {
  const text = (key: string) => facts.find((f) => f.key === key)?.content.trim() || undefined;
  const team = text("club.team");
  const competition = text("club.competition");
  return { ...(team ? { team } : {}), ...(competition ? { competition } : {}) };
}

/**
 * The club's locale, from its house facts: `locale.timezone` (an IANA zone, `Europe/London`: the
 * zone its fans read a kick-off in) and `locale.date-order` (`day-first` or `month-first`, for a
 * date-only value that could be read either way). What a page shows is never the machine's.
 */
export function localeFacts(facts: ReadonlyArray<{ key: string | null; content: string }>): {
  timeZone?: string;
  dateOrder?: "dmy" | "mdy";
} {
  const text = (key: string) => facts.find((f) => f.key === key)?.content.trim();
  const zone = text("locale.timezone");
  let valid: string | undefined;
  try {
    if (zone) new Intl.DateTimeFormat("en-US", { timeZone: zone });
    valid = zone;
  } catch {
    valid = undefined; // not an IANA zone: left out rather than guessed at
  }
  const order = text("locale.date-order")?.toLowerCase();
  return {
    ...(valid ? { timeZone: valid } : {}),
    ...(order?.startsWith("day") || order === "dmy"
      ? { dateOrder: "dmy" as const }
      : order?.startsWith("month") || order === "mdy"
        ? { dateOrder: "mdy" as const }
        : {}),
  };
}

export const LOCALE_RULE =
  "The zone a time is shown in and the order a date-only value is read in, from the club's house facts. A page shows an instant in timeZone unless a date pipe names another zone; name one only when the design needs a different zone. Prefer the feed's instant field (a kickoff) with a date pipe over a pre-formatted local date or time string when the data has both: the date and the time then come from one value.";

export const FEEDS_RULE =
  "These are the club's own feeds, kept as house facts. When the list you are binding is what a kind gives (squad: players or a team; schedule: fixtures, matches or results; standings: a table), call agent.hookMaker with those feeds as need.sources (label and url exactly as listed) before you ask a person for one. The shape of the output stays the design's.";
