/**
 * Sweeps the heatmap an earlier version of this plugin could leave behind.
 * FIGMA-AWARE.
 *
 * The heatmap drew a locked frame named `__fos_heatmap__` into the client's
 * file. The feature is gone (the fix queue already says what to fix, and a
 * leftover overlay in a client file costs more trust than the colours earned),
 * but a file saved while one was up still holds it. Removed once, at startup.
 */
import { errorMessage } from "./traverse";

const LEGACY_FRAME_NAME = "__fos_heatmap__";

export function clearLegacyOverlays(): number {
  let removed = 0;
  for (const node of figma.currentPage.children) {
    if (node.name !== LEGACY_FRAME_NAME) continue;
    try {
      node.remove();
      removed++;
    } catch (err) {
      console.log(`[fanos-studio] overlay cleanup failed: ${errorMessage(err)}`);
    }
  }
  return removed;
}
