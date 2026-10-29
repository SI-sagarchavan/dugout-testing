import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Holds tool outputs too large for the transcript, scoped by run. */
export interface OutputStore {
  put(runId: string, content: string): Promise<string>;
  read(runId: string, ref: string): Promise<string | undefined>;
}

const REF = /^out-\d+$/;

export function createMemoryOutputStore(): OutputStore {
  const runs = new Map<string, string[]>();
  return {
    async put(runId, content) {
      const outputs = runs.get(runId) ?? [];
      runs.set(runId, outputs);
      return `out-${outputs.push(content)}`;
    },
    async read(runId, ref) {
      if (!REF.test(ref)) return undefined;
      return runs.get(runId)?.[Number(ref.slice(4)) - 1];
    },
  };
}

/** Writes to `<root>/<runId>/outputs/<ref>.txt`. */
export function createFileOutputStore(root: string): OutputStore {
  const counts = new Map<string, number>();
  const file = (runId: string, ref: string) => join(root, runId, "outputs", `${ref}.txt`);
  return {
    async put(runId, content) {
      const n = (counts.get(runId) ?? 0) + 1;
      counts.set(runId, n);
      const ref = `out-${n}`;
      await mkdir(join(root, runId, "outputs"), { recursive: true });
      await writeFile(file(runId, ref), content);
      return ref;
    },
    async read(runId, ref) {
      if (!REF.test(ref)) return undefined;
      return readFile(file(runId, ref), "utf8").catch(() => undefined);
    },
  };
}
