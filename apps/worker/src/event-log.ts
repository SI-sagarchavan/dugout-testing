import type { EventSink, RunEvent } from "@dugout/contracts";
import { type Pool, withTenant } from "@dugout/db";
import type { Valkey } from "iovalkey";

export const LOCAL_VALKEY_URL = "redis://localhost:56379";
/** Live streams are kept this long after a run ends; Postgres has the permanent record. */
const RETAIN_SECONDS = 7 * 24 * 3600;

/** The run is over. */
export const isTerminal = (e: RunEvent) =>
  e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled";
/** The invocation is over: the run ended, or it waits for a person to decide an approval. */
export const endsInvocation = (e: RunEvent) => e.type === "approval.requested" || isTerminal(e);
/** Streamed fragments: only the live stream has them; the finished messages are in the record. */
const LIVE_ONLY = new Set<RunEvent["type"]>(["token", "tool.input.delta"]);
const parse = (fields: string[]) => JSON.parse(fields[1] ?? "null") as RunEvent;

/**
 * Each run's events in a Valkey stream whose entry ids are `0-<seq>`, so a client that has seen
 * `seq` resumes with an exclusive range from that id: no gaps and no duplicates. `keyPrefix` puts
 * the keys in a namespace on a shared cluster (`fanos:prod:dugout:`).
 */
export function createValkeyEventLog(valkey: Valkey, opts: { keyPrefix?: string } = {}) {
  const streamKey = (runId: string) => `${opts.keyPrefix ?? ""}run:${runId}:events`;
  const read = async (runId: string, afterSeq: number) => {
    const entries = await valkey.xrange(streamKey(runId), `(0-${afterSeq}`, "+");
    return entries.map(([, fields]) => parse(fields));
  };

  return {
    sink: (): EventSink => ({
      async write(event) {
        const key = streamKey(event.runId);
        await valkey.xadd(key, `0-${event.seq}`, "e", JSON.stringify(event));
        if (isTerminal(event)) await valkey.expire(key, RETAIN_SECONDS);
      },
    }),

    exists: async (runId: string) => (await valkey.exists(streamKey(runId))) === 1,

    /** `seq` of the newest event in the run's stream (tokens included), or 0. */
    async lastSeq(runId: string) {
      const [newest] = await valkey.xrevrange(streamKey(runId), "+", "-", "COUNT", 1);
      return newest ? parse(newest[1]).seq : 0;
    },

    read,

    /**
     * Backlog after `afterSeq`, then the live tail until the run ends, `stopAt` matches an event
     * (`endsInvocation` follows one invocation), or `signal` aborts.
     */
    async *follow(
      runId: string,
      afterSeq: number,
      signal: AbortSignal,
      stopAt: (e: RunEvent) => boolean = isTerminal,
    ): AsyncGenerator<RunEvent> {
      const stops = (e: RunEvent) => isTerminal(e) || stopAt(e);
      let last = afterSeq;
      for (const event of await read(runId, last)) {
        yield event;
        last = event.seq;
        if (stops(event)) return;
      }
      // Nothing after `last`: if the newest entry ends the run, the client has seen everything.
      const [newest] = await valkey.xrevrange(streamKey(runId), "+", "-", "COUNT", 1);
      if (newest && isTerminal(parse(newest[1]))) return;
      // blocking reads need their own connection; aborting closes it, ending a read in progress
      const reader = valkey.duplicate();
      const stop = () => reader.disconnect();
      signal.addEventListener("abort", stop, { once: true });
      try {
        while (!signal.aborted) {
          const res = await reader
            .xread("BLOCK", 2_000, "STREAMS", streamKey(runId), `0-${last}`)
            .catch((err) => {
              if (signal.aborted) return null;
              throw err;
            });
          for (const [, entries] of res ?? []) {
            for (const [, fields] of entries) {
              const event = parse(fields);
              if (event.seq <= last) continue;
              yield event;
              last = event.seq;
              if (stops(event)) return;
            }
          }
        }
      } finally {
        signal.removeEventListener("abort", stop);
        reader.disconnect();
      }
    },
  };
}

export type ValkeyEventLog = ReturnType<typeof createValkeyEventLog>;

/** The permanent record: every event except streamed fragments, plus the run's final status. */
export function createPostgresEventSink(pool: Pool, tenantId: string): EventSink {
  return {
    async write(event) {
      if (LIVE_ONLY.has(event.type)) return;
      await withTenant(pool, tenantId, async (db) => {
        await db.query(
          `insert into run_events (run_id, seq, tenant_id, type, data, at)
           values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
          [event.runId, event.seq, tenantId, event.type, event.data, event.at],
        );
        if (isTerminal(event)) {
          const status =
            event.type === "run.completed"
              ? event.data.status
              : event.type === "run.failed"
                ? "failed"
                : "cancelled";
          await db.query(
            "update runs set status = $2, result = $3, updated_at = now() where id = $1",
            [event.runId, status, event.data],
          );
        }
      });
    },
  };
}

export async function readStoredEvents(
  pool: Pool,
  tenantId: string,
  runId: string,
  afterSeq: number,
) {
  return withTenant(pool, tenantId, async (db) => {
    const { rows } = await db.query(
      `select run_id, seq, type, data, at from run_events
       where run_id = $1 and seq > $2 order by seq`,
      [runId, afterSeq],
    );
    return rows.map(
      (r) =>
        ({
          runId: r.run_id,
          seq: r.seq,
          type: r.type,
          data: r.data,
          at: new Date(r.at).toISOString(),
        }) as RunEvent,
    );
  });
}
