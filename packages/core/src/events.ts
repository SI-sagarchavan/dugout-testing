import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink, RunEvent, RunEventInput } from "@dugout/contracts";
import { createRedactor, type Redactor } from "./redact.ts";

export interface RunLog {
  emit(event: RunEventInput): Promise<void>;
  /** `seq` of the last event emitted. */
  lastSeq(): number;
}

/**
 * Stamps `runId`, `seq` and `at`, redacts the payload, and writes to every sink in order. Writes are
 * chained so sinks see events in `seq` order even when callers don't await `emit`. A resumed run
 * passes `startSeq`, the last `seq` its event log already holds.
 */
export function createRunLog(
  runId: string,
  sinks: EventSink[],
  opts: { redactor?: Redactor; now?: () => Date; startSeq?: number } = {},
): RunLog {
  const redactor = opts.redactor ?? createRedactor();
  const now = opts.now ?? (() => new Date());
  let seq = opts.startSeq ?? 0;
  let chain: Promise<void> = Promise.resolve();
  return {
    emit(input) {
      const event = {
        ...input,
        data: redactor.value(input.data),
        runId,
        seq: ++seq,
        at: now().toISOString(),
      } as RunEvent;
      chain = chain.then(async () => {
        for (const sink of sinks) await sink.write(event);
      });
      return chain;
    },
    lastSeq: () => seq,
  };
}

export function createMemorySink(): EventSink & { events: RunEvent[] } {
  const events: RunEvent[] = [];
  return { events, write: (event) => void events.push(event) };
}

export function createJsonlSink(file: string): EventSink {
  let ready: Promise<unknown> | undefined;
  return {
    async write(event) {
      ready ??= mkdir(dirname(file), { recursive: true });
      await ready;
      await appendFile(file, `${JSON.stringify(event)}\n`);
    },
  };
}
