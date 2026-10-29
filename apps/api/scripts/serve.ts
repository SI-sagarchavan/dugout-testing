// pnpm api — HTTP/SSE API on :8787 (PORT), running agents in this process.

import { createMatchPreview, Input, liveDeps } from "@dugout/agent-match-preview";
import { loadTenants } from "@dugout/core";
import { serve } from "@hono/node-server";
import { Valkey } from "iovalkey";
import {
  createApp,
  createRunManager,
  createValkeyEventLog,
  LOCAL_DEV_SECRET,
  LOCAL_VALKEY_URL,
} from "../src/index.ts";

const deps = liveDeps();
const secret = process.env.DUGOUT_JWT_SECRET || LOCAL_DEV_SECRET;
const valkey = new Valkey(process.env.VALKEY_URL || LOCAL_VALKEY_URL);
const events = createValkeyEventLog(valkey);
const preview = createMatchPreview(deps);
const runs = createRunManager({
  pool: deps.pool,
  events,
  agents: {
    "match-preview": {
      input: Input,
      run: (opts) =>
        preview({
          ...opts,
          sinks: [...opts.sinks, ...(deps.tracing ? [deps.tracing.sink()] : [])],
        }),
    },
  },
  onError: (runId, err) => console.error(`run ${runId} crashed:`, err),
});
const app = createApp({ pool: deps.pool, runs, events, tenants: loadTenants(), secret });

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port }, () =>
  console.log(
    `dugout api on http://localhost:${port}${deps.tracing ? " (tracing to Langfuse)" : ""}`,
  ),
);
