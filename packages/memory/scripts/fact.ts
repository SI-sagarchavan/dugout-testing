// pnpm agent memory fact --tenant sb --key media.player-photo "Player photos: https://cdn.club/players/{id}.png"
// A house fact a person writes. It is proposed, for `pnpm agent memory review`; --approve makes it
// active now, reviewed by you. Every agent of the tenant that reads house facts reads it.
//
// `media.<what>` facts say where pictures the data has no field for are: a URL with `{field}` for
// the item's field it is built from. data-bind binds a picture's src with it (the player's photo
// from the player's id), where without it every card would show the design's first photo.
//
// --value gives the answer a run's question is proposed, and answered with once the fact is active
// (ADR 0033): `--key media.image-domain --value https://www.club.com "Images are served from …"`.
// JSON is read as JSON (true, 3, ["a","b"]); anything else is text.
import { userInfo } from "node:os";
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { createPool } from "@dugout/db";
import { createMemoryStore, loadEmbeddings } from "../src/index.ts";

loadEnv();
const { values, positionals } = parseArgs({
  options: {
    tenant: { type: "string" },
    key: { type: "string" },
    approve: { type: "boolean" },
    value: { type: "string" },
  },
  allowPositionals: true,
});
const content = positionals.join(" ").trim();
const usage =
  'usage: pnpm agent memory fact --tenant <id> --key <key> [--value <answer>] [--approve] "<the fact>"\n' +
  '  e.g. --key media.player-photo "Player photos: https://cdn.club/players/{id}.png"';
if (!values.tenant || !values.key || !content) {
  console.error(usage);
  process.exit(2);
}
const problem = factProblem(values.key, content);
if (problem) {
  console.error(`${problem}\n${usage}`);
  process.exit(2);
}

const tenant = loadTenants().require(values.tenant);
const pool = createPool();
const store = createMemoryStore({ pool, embeddings: loadEmbeddings() });
try {
  const value = values.value === undefined ? undefined : typedValue(values.value);
  const current = (await store.activeFacts(tenant.id)).find((f) => f.key === values.key);
  if (
    current?.content === content &&
    JSON.stringify(current.value) === JSON.stringify(value ?? null)
  ) {
    console.log(`${tenant.id} ${values.key}: already the active fact`);
  } else {
    const proposed = await store.proposeFact({
      tenantId: tenant.id,
      agentId: null,
      key: values.key,
      content,
      confidence: 1,
      sourceRunId: null,
      ...(value === undefined ? {} : { value }),
    });
    if (current) console.log(`  now:      ${current.content}`);
    if (values.approve) {
      await store.activateFact(tenant.id, proposed.id, userInfo().username);
      console.log(
        `${tenant.id} ${values.key}: active. Every agent that reads house facts reads it.`,
      );
    } else {
      console.log(
        `${tenant.id} ${values.key}: proposed. Approve it with pnpm agent memory review --tenant ${tenant.id}`,
      );
    }
  }
} finally {
  await pool.end();
}

/** An answer as typed: JSON when it reads as JSON, else the text. */
function typedValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** What is wrong with a fact before it is stored, or undefined. */
function factProblem(key: string, text: string): string | undefined {
  if (!/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/.test(key)) {
    return `key "${key}" is lower case words joined by dots: media.player-photo`;
  }
  if (key.startsWith("media.")) {
    const url = text.match(/https?:\/\/\S+/)?.[0];
    if (!url) return "a media fact names the picture's whole URL, https://…";
    if (!/\{[A-Za-z_][\w.]*\}/.test(url)) {
      return "a media fact's URL names the item field it is built from in braces: {id}";
    }
  }
  return undefined;
}
