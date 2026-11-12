// `pnpm scre:sync` (scripts/scre-sync.ts) lives at the root, which no package's tests cover; its
// rewrite is tested here.
import { describe, expect, it } from "vitest";
import { applyPatches, relativeSpecifier, rewriteImports } from "../../../scripts/scre-sync-lib.ts";

describe("scre:sync rewrite", () => {
  it("points @fanos imports at SCRE's own files, relative to the copy", () => {
    const source = [
      'import type { Node } from "@fanos/dsl";',
      'import { evaluateCondition } from "@fanos/dsl/runtime";',
      'import { cssVar } from "@fanos/tokens";',
      'import { ClockText } from "@fanos/renderer/client";',
      "// a comment naming @fanos/dsl stays as it is",
    ].join("\n");
    expect(rewriteImports(source, "components/Text.tsx")).toBe(
      [
        'import type { Node } from "../dsl/index.js";',
        'import { evaluateCondition } from "../dsl/index.js";',
        'import { cssVar } from "../tokens.js";',
        'import { ClockText } from "../client.js";',
        "// a comment naming @fanos/dsl stays as it is",
      ].join("\n"),
    );
    expect(rewriteImports('import { CATEGORIES } from "@fanos/tokens";', "dsl/values.ts")).toBe(
      'import { CATEGORIES } from "../tokens.js";',
    );
    expect(
      rewriteImports('import type { Category } from "@fanos/tokens";', "dsl/nodes/leaves.ts"),
    ).toBe('import type { Category } from "../../tokens.js";');
    expect(rewriteImports('export { x } from "@fanos/dsl";', "client.tsx")).toBe(
      'export { x } from "./dsl/index.js";',
    );
  });

  it("refuses a @fanos import SCRE has no file for", () => {
    expect(() =>
      rewriteImports('import { loadTheme } from "@fanos/tokens/node";', "page.ts"),
    ).toThrow(/@fanos\/tokens\/node/);
  });

  it("writes relative specifiers as imports do", () => {
    expect(relativeSpecifier("client.tsx", "tokens.js")).toBe("./tokens.js");
    expect(relativeSpecifier("dsl/machine/expr.ts", "tokens.js")).toBe("../../tokens.js");
  });

  it("stops when a patch no longer matches dugout's file", () => {
    expect(() => applyPatches("gap: var(--fos-space-2, 0.5rem);", "styles.css")).toThrow(/PATCHES/);
    expect(applyPatches("unpatched file", "components/Box.tsx")).toBe("unpatched file");
  });
});
