import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMAS_DIR, schemaFiles } from "../src/index.ts";

describe("schemas for hosts", () => {
  it("are committed for every agent and match it; run `pnpm agent schemas` when this fails", async () => {
    const files = await schemaFiles();
    const committed = (await readdir(SCHEMAS_DIR)).filter((f) => f.endsWith(".json")).sort();
    expect(committed).toEqual(Object.keys(files).sort());
    for (const [name, content] of Object.entries(files)) {
      expect(await readFile(join(SCHEMAS_DIR, name), "utf8"), name).toBe(content);
    }
  });
});
