import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventSink, RunEvent, RunEventInput } from "@dugout/contracts";
import { createRedactor, type Redactor } from "./redact.ts";

export interface RunLog {
  emit(event: RunEventInput): Promise<void>;
  /**
   * Writes a child run's event as this run's next one: this run's `runId`, `seq` and `at`, the
   * child's `type`, `data` and `child` kept. Its payload was redacted when the child wrote it.
   */
  relay(event: RunEvent): Promise<void>;
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
  const write = (event: RunEvent) => {
    chain = chain.then(async () => {
      for (const sink of sinks) await sink.write(event);
    });
    return chain;
  };
  return {
    emit(input) {
      return write({
        ...input,
        data: redactor.value(input.data),
        runId,
        seq: ++seq,
        at: now().toISOString(),
      } as RunEvent);
    },
    relay(event) {
      if (!event.child) throw new Error("only a child run's event is relayed");
      return write({ ...event, runId, seq: ++seq });
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
