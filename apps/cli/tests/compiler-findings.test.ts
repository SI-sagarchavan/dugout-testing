import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FINDINGS_DIR, findingKey, recordCompilerFindings } from "../src/compiler-findings.ts";

const root = () => mkdtempSync(join(tmpdir(), "findings-"));
const files = (r: string) => readdirSync(join(r, FINDINGS_DIR)).sort();

describe("recordCompilerFindings", () => {
  it("ignores the node id, so one gap on two frames is one key", () => {
    expect(findingKey("I293:10343;18172:25176: Preserve group opacity.")).toBe(
      findingKey("I9:1;2:3: preserve  group opacity."),
    );
  });

  it("files a new gap as a needs-triage ticket", () => {
    const r = root();
    const out = recordCompilerFindings(r, ["293:10343: preserve the root gradient"], {
      runId: "a",
    });
    expect(out.created).toEqual(["01-preserve-the-root-gradient.md"]);
    expect(readFileSync(join(r, FINDINGS_DIR, out.created[0] as string), "utf8")).toContain(
      "Status: needs-triage",
    );
  });

  it("adds a line to the ticket a second run repeats, not a second ticket", () => {
    const r = root();
    recordCompilerFindings(r, ["1:2: preserve group opacity"], { runId: "a" });
    const out = recordCompilerFindings(r, ["7:8: Preserve group opacity", "3:4: another gap"], {
      runId: "b",
      frame: "Squad",
    });
    expect(out.repeated).toEqual(["01-preserve-group-opacity.md"]);
    expect(out.created).toEqual(["02-another-gap.md"]);
    expect(files(r)).toHaveLength(2);
    const text = readFileSync(join(r, FINDINGS_DIR, "01-preserve-group-opacity.md"), "utf8");
    expect(text).toContain("run a");
    expect(text).toContain("run b · Squad");
  });
});
