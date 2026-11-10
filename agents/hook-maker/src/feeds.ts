import { defineTool } from "@dugout/contracts";
import { z } from "zod";

/**
 * How feeds a person gave become Cast providers and connectors, worked out by code so every
 * run splits them the same way (`.scratch/data-sources/issues/03`, `17`):
 *
 * - one provider for each URL origin (scheme, host and port), its `baseUrl` the origin and nothing
 *   more, so a provider is found again by its origin whatever paths its feeds have;
 * - one connector for each distinct path (written whole after `{{env.base_url}}`, a trailing slash
 *   kept); feeds that differ only in their query values (one per option of a choice) are one
 *   connector, called with each feed's values;
 * - each query parameter, in the order and as often as the feeds write it, still encoded: a literal
 *   when every feed of the connector has the same value, an input (`{{input.<name>}}`, the name made
 *   safe) when they differ or only some feeds have it, each call setting only the inputs its feed has;
 * - a value that looks like a secret (a key, a token, a signature, a password, or a long random
 *   string) is never a literal of a connector others share: it is `{{cred.<name>}}`, and reported in
 *   `secrets` for a person to add to Cast. A URL with credentials in it (`https://user:pass@…`) is
 *   refused.
 */
export interface FeedSource {
  label: string;
  url: string;
}

export interface PlannedConnector {
  /** The whole path after the provider's base URL, as the connector's `url` writes it. */
  url: string;
  /**
   * Query parameters the connector sends, in order (a key written twice is sent twice). `value` is
   * a literal (encoded as the feed wrote it), `{{input.<name>}}` or `{{cred.<name>}}`.
   */
  queryParams: Array<{ key: string; value: string }>;
  /**
   * The feeds that call it, each with the inputs its call sets (as the step's overrides): only the
   * parameters that feed has. A secret's value is never here, nor in `url`.
   */
  calls: Array<{ label: string; url: string; input: Record<string, string> }>;
}

export interface PlannedProvider {
  origin: string;
  /** The provider's `baseUrl`: the origin, no path. */
  baseUrl: string;
  /** Its name: `dugout: <host>`. */
  name: string;
  connectors: PlannedConnector[];
}

/** A value a feed sends that a person must add to Cast as a credential, never a literal. */
export interface PlannedSecret {
  /** The feeds that send it. */
  labels: string[];
  /** The query parameter. */
  key: string;
  /** The credential the connector reads it from: `{{cred.<cred>}}`. */
  cred: string;
  /** Why it reads as a secret. */
  why: string;
}

/** Query parameter names that hold a secret, as words of the name (`api_key`, `accessToken`). */
const SECRET_WORDS = new Set([
  "key",
  "apikey",
  "token",
  "secret",
  "signature",
  "sig",
  "password",
  "passwd",
  "pwd",
  "pass",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "hmac",
  "jwt",
]);

const wordsOfName = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Why a parameter is a secret, or undefined. `value` is decoded. */
export function secretWhy(key: string, value: string): string | undefined {
  const named = wordsOfName(key).find((w) => SECRET_WORDS.has(w));
  if (named) return `its name says it is a ${named}`;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (
    !uuid &&
    value.length >= 24 &&
    /^[A-Za-z0-9_\-+/=.~]+$/.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value)
  ) {
    return "its value is a long random string";
  }
  return undefined;
}

/** A name Cast takes for an input or a credential: `f[t]` is `f_t`. */
export function safeName(key: string): string {
  let decoded = key;
  try {
    decoded = decodeURIComponent(key);
  } catch {
    // as written
  }
  const name = decoded
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return !name ? "param" : /^\d/.test(name) ? `p_${name}` : name;
}

interface Param {
  /** The key as written. */
  key: string;
  /** The value as written (encoded). */
  raw: string;
  /** Which time this key is written in its query: 0 for the first. */
  nth: number;
}

/** A query as written: every parameter in order, repeated keys kept, nothing decoded. */
function paramsOf(search: string): Param[] {
  const seen = new Map<string, number>();
  return search
    .replace(/^\?/, "")
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      const key = at < 0 ? part : part.slice(0, at);
      const raw = at < 0 ? "" : part.slice(at + 1);
      const nth = seen.get(key) ?? 0;
      seen.set(key, nth + 1);
      return { key, raw, nth };
    });
}

const decoded = (raw: string) => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
};

export function planFeeds(sources: FeedSource[]): {
  providers: PlannedProvider[];
  refused: string[];
  secrets: PlannedSecret[];
} {
  const refused: string[] = [];
  const byOrigin = new Map<string, Array<FeedSource & { parsed: URL; params: Param[] }>>();
  for (const source of sources) {
    let parsed: URL;
    try {
      parsed = new URL(source.url);
    } catch {
      refused.push(`${source.label}: ${source.url} is not a URL`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      refused.push(`${source.label}: ${source.url} is not an http(s) URL`);
      continue;
    }
    if (parsed.username || parsed.password) {
      refused.push(
        `${source.label}: the URL has a user name or password in it (${parsed.protocol}//…@${parsed.host}): a secret never goes in a connector. Ask for the feed without it, and add the credential in Cast`,
      );
      continue;
    }
    const raw = source.url.replace(/#.*$/, "");
    const at = raw.indexOf("?");
    const params = paramsOf(at < 0 ? "" : raw.slice(at));
    byOrigin.set(parsed.origin, [
      ...(byOrigin.get(parsed.origin) ?? []),
      { ...source, parsed, params },
    ]);
  }
  const secrets = new Map<string, PlannedSecret>();
  const providers: PlannedProvider[] = [];
  for (const [origin, feeds] of byOrigin) {
    // one connector for each path, written whole and as given (`/x/y/` is not `/x/y`)
    const byPath = new Map<string, typeof feeds>();
    for (const feed of feeds) {
      byPath.set(feed.parsed.pathname, [...(byPath.get(feed.parsed.pathname) ?? []), feed]);
    }
    const connectors: PlannedConnector[] = [...byPath].map(([path, group]) => {
      // each parameter by its key and which time it is written, in the order the feeds write them
      const slots = new Map<string, { key: string; nth: number }>();
      for (const feed of group) {
        for (const p of feed.params)
          slots.set(`${p.nth}\u0000${p.key}`, { key: p.key, nth: p.nth });
      }
      const names = new Set<string>();
      const nameFor = (key: string) => {
        const base = safeName(key);
        let name = base;
        for (let n = 2; names.has(name); n++) name = `${base}_${n}`;
        names.add(name);
        return name;
      };
      const planned = [...slots.values()].map(({ key, nth }) => {
        const values = group.map((f) => f.params.find((p) => p.key === key && p.nth === nth));
        const secret = values
          .map((v) => (v ? secretWhy(decoded(key), decoded(v.raw)) : undefined))
          .find(Boolean);
        if (secret) {
          const cred = safeName(key);
          const known = secrets.get(cred);
          secrets.set(cred, {
            key: decoded(key),
            cred,
            why: secret,
            labels: [
              ...new Set([
                ...(known?.labels ?? []),
                ...group.filter((_, i) => values[i]).map((f) => f.label),
              ]),
            ],
          });
          return { key, nth, value: `{{cred.${cred}}}`, secret: true, input: undefined };
        }
        const first = values[0]?.raw;
        const same = values.every((v) => v !== undefined && v.raw === first);
        if (same && first !== undefined) {
          return { key, nth, value: first, secret: false, input: undefined };
        }
        const input = nameFor(key);
        return { key, nth, value: `{{input.${input}}}`, secret: false, input };
      });
      return {
        url: `{{env.base_url}}${path}`,
        queryParams: planned.map(({ key, value }) => ({ key, value })),
        calls: group.map((f) => {
          let url = f.url;
          for (const p of planned.filter((q) => q.secret)) {
            const v = f.params.find((x) => x.key === p.key && x.nth === p.nth);
            if (v?.raw) url = url.split(`${p.key}=${v.raw}`).join(`${p.key}=${p.value}`);
          }
          const input: Record<string, string> = {};
          for (const p of planned) {
            if (!p.input) continue;
            const v = f.params.find((x) => x.key === p.key && x.nth === p.nth);
            if (v) input[p.input] = v.raw;
          }
          return { label: f.label, url, input };
        }),
      };
    });
    providers.push({
      origin,
      baseUrl: origin,
      name: `dugout: ${new URL(origin).host}`,
      connectors,
    });
  }
  return { providers, refused, secrets: [...secrets.values()] };
}

export const planFeedsTool = defineTool({
  name: "feeds.plan",
  description:
    "Work out the providers and connectors for the feeds a person gave (need.sources), the same way every time: one provider for each origin (its base URL the origin, no path: look an existing one up by it), one connector for each path (the whole path in its url), and its query parameters in order, still encoded: a literal when every feed has the same value, an input when they differ or only some feeds have it (each call's input says what that feed sets), a credential ({{cred.<name>}}) for a value that looks like a secret, listed in secrets. Create exactly what it says with cast.upsertProvider and cast.upsertApi. Takes the sources as given; reads nothing.",
  input: z
    .object({
      sources: z.array(z.object({ label: z.string().min(1), url: z.string().min(1) })).min(1),
    })
    .strict(),
  effect: "read",
  timeoutMs: 5_000,
  async run({ sources }) {
    return planFeeds(sources);
  },
});
