/**
 * The registry and the runner. PURE — no Figma import.
 *
 * `lint()` is the whole engine: it takes Frame IR and a reconciled theme and
 * returns everything the panel draws. The same call is what a CI handoff gate
 * would make, which is the reason none of this touches Figma.
 *
 * Every rule declares the downstream failure it prevents. If one cannot, it does
 * not belong in this array. B1 (root not a column), B3 (no mobile frame) and W1
 * (default layer names) were removed on that test: B3 fired on all 18 eval
 * frames and B1 on 16, every one of which compiles and publishes.
 */
import { buildBatches, batchesToReach, safeSlotCount } from "../health/batch.js";
import { coverageFromSlots } from "../health/coverage.js";
import { sizingReport } from "../health/sizing.js";
import { enumerateSlots } from "../health/slots.js";
import type {
  Batch,
  Finding,
  LintContext,
  LintReport,
  Proposal,
  Rule,
  StructuralAction,
} from "../health/types.js";
import { isStructuralProposal } from "../health/types.js";
import type { FrameIRDocument } from "../ir/schema.js";

import { groupsInsteadOfFrames } from "./s1-groups-instead-of-frames.js";
import { sectionsUnmarked } from "./s2-sections-unmarked.js";
import { unboundFill } from "./f1-unbound-fill.js";
import { unboundStroke } from "./f2-unbound-stroke.js";
import { unboundTextStyle } from "./f3-unbound-text-style.js";
import { unboundSpacing } from "./f4-unbound-spacing.js";
import { unboundRadius } from "./f5-unbound-radius.js";
import { unboundEffect } from "./f6-unbound-effect.js";

/**
 * How the frame is built. Pinned text is the other structure check; it is read
 * from the sizing report, not a rule, because its fix is a bulk property change
 * and not a finding with a proposal.
 */
export const STRUCTURE: readonly Rule[] = [groupsInsteadOfFrames, sectionsUnmarked];

/** Whether each value follows a theme. */
export const TOKENS: readonly Rule[] = [
  unboundFill,
  unboundStroke,
  unboundTextStyle,
  unboundSpacing,
  unboundRadius,
  unboundEffect,
];

export const RULES: readonly Rule[] = [...STRUCTURE, ...TOKENS];

export function ruleById(id: string): Rule | undefined {
  return RULES.find((rule) => rule.id === id);
}

export interface LintEntry {
  finding: Finding;
  proposal: Proposal | null;
  ruleCode: string;
}

export function lint(ir: FrameIRDocument, ctx: LintContext, startedAt = 0): LintReport {
  const entries: LintEntry[] = [];
  const structure: Finding[] = [];
  const actions: StructuralAction[] = [];

  for (const rule of RULES) {
    const findings = rule.check(ir, ctx);
    for (const finding of findings) {
      if (rule.group === "structure") {
        structure.push(finding);
        const proposal = rule.propose ? rule.propose(finding, ctx) : null;
        if (proposal && isStructuralProposal(proposal)) {
          actions.push({
            id: proposal.action,
            ruleId: rule.id,
            ruleCode: rule.code,
            label: proposal.label,
            hint: finding.hint ?? "",
            count: proposal.nodeIds.length > 0 ? proposal.nodeIds.length : 1,
            nodeIds: proposal.nodeIds,
          });
        }
        continue;
      }
      entries.push({
        finding,
        proposal: rule.propose ? (rule.propose(finding, ctx) ?? null) : null,
        ruleCode: rule.code,
      });
    }
  }

  const slots = enumerateSlots(ir.root);
  const batches: Batch[] = buildBatches(
    entries.map((entry) => ({
      finding: entry.finding,
      proposal: entry.proposal,
      rule: { id: entry.finding.ruleId, code: entry.ruleCode },
    })),
    slots.length,
  );

  const oneClickAway = safeSlotCount(batches);
  const coverage = coverageFromSlots(slots, oneClickAway);

  return {
    irVersion: ir.irVersion,
    fileName: ir.fileName,
    pageName: ir.pageName,
    rootNodeId: ir.rootNodeId,
    rootName: ir.root.name,
    themeId: ctx.theme.themeId,
    themeName: ctx.theme.themeName,
    breakpoint: ctx.breakpoint,
    coverage,
    sizing: sizingReport(ir),
    structure,
    batches,
    actions,
    fixableFindings: entries.length,
    batchesFor90Percent: batchesToReach(batches, coverage.loose, 90),
    distinctLooseValues: new Set(
      entries
        .filter((entry) => entry.finding.occupiesSlot)
        .map((entry) => `${entry.finding.scope}|${entry.finding.currentValue}`),
    ).size,
    options: ctx.options,
    durationMs: startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0,
  };
}
