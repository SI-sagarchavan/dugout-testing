/**
 * Autofix: the one action that stands for the whole queue.
 *
 * It applies exactly the batches already marked safe: exact value match, real
 * variable behind the token. That set is what the readiness bar's "one click
 * away" is counting, so the payoff on this button and the gap on the bar are the
 * same number by construction.
 *
 * It is deliberately NOT a shortcut around review. Near matches stay out of it,
 * and the label says how many are waiting, so "autofix" never quietly means
 * "guessed at 36 layers of your brand red".
 */
import type { JSX } from "react";
import { isFixProposal } from "../health/types.js";
import { send } from "./main.js";
import type { StudioState } from "./state.js";

export function Autofix({ state }: { state: StudioState }): JSX.Element | null {
  const report = state.report;
  if (!report) return null;

  const safe = report.batches.filter((batch) => batch.safe);
  const layers = safe.reduce((sum, batch) => sum + batch.count, 0);

  // Exact matches whose token simply does not exist here. Creating them is the
  // unlock, and it is a different promise from binding — so it gets its own
  // button and its own words, never a silent step inside Autofix.
  const creatable = new Set<string>();
  for (const batch of report.batches) {
    const proposal = batch.proposal;
    if (!proposal || !isFixProposal(proposal)) continue;
    if (proposal.bindable) continue;
    if (proposal.kind === "exact" || proposal.kind === "near") creatable.add(proposal.tokenRef);
  }

  if (layers === 0) {
    if (creatable.size === 0) return null;
    return (
      <button
        className="fs-btn is-text"
        disabled={state.busy}
        onClick={() => send({ type: "create-variables" })}
        title={`Creates ${[...creatable].join(", ")} with the theme's values, then re-checks`}
      >
        Add {creatable.size} {creatable.size === 1 ? "variable" : "variables"}
      </button>
    );
  }

  const reviewable = report.batches.filter(
    (batch) => batch.proposal && isFixProposal(batch.proposal) && batch.proposal.kind === "near",
  ).length;

  return (
    <button
      className="fs-btn is-text"
      disabled={state.busy}
      onClick={() => send({ type: "autofix" })}
      title={[
        `Worth +${report.coverage.oneClickPercent}%. Binds ${layers} layers across ${safe.length} ${safe.length === 1 ? "batch" : "batches"}, in one undo step:`,
        ...safe.map((batch) => `  ${batch.count} × ${batch.label} → ${tokenOf(batch)}`),
        reviewable > 0
          ? `\n${reviewable} near-match ${reviewable === 1 ? "batch" : "batches"} left for you to review.`
          : "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      Bind {layers} exact
    </button>
  );
}

function tokenOf(batch: { proposal: unknown }): string {
  const proposal = batch.proposal as { tokenRef?: string } | null;
  return proposal?.tokenRef ?? "—";
}
