/**
 * Handoffs: what the Handoff tab shows while frames go out, and what the History tab
 * remembers afterwards.
 *
 * One click on Handoff is a *batch*: a list of frames, each sent on its own (one Handoff
 * per frame, so one agent build per frame). The batch record is the one structure
 * both tabs draw — the Handoff tab while it is in flight, History once it is history —
 * and it is plain data so it survives `figma.clientStorage` and postMessage.
 *
 * Status here is what the plugin can honestly know: whether the files left the
 * building. What Studio does with them afterwards (matching, binding, waiting
 * for approval) is not visible from here until a batches API exists, and a status
 * the plugin invented would be worse than none. `BatchesSource` is the seam that
 * API plugs into.
 *
 * PURE. No Figma, no DOM.
 */

export type FrameHandoffStatus =
  /** Queued behind another frame of the same batch. */
  | "waiting"
  /** Reading the frame: IR, screenshots, marked assets. */
  | "walking"
  /** The files are on their way to Studio. */
  | "uploading"
  | "sent"
  | "failed"
  /** The designer stopped the batch before this frame went out. */
  | "cancelled";

export interface FrameHandoff {
  frameId: string;
  name: string;
  status: FrameHandoffStatus;
  /** Files in the send: the IR, the screenshots, the marked assets. 0 until walked. */
  files: number;
  /** Why it failed. Only set when `status` is `failed`. */
  error?: string;
}

export interface HandoffBatch {
  id: string;
  /** ms since epoch, when the designer pressed Handoff. */
  at: number;
  fileName: string;
  /** The Studio the frames were sent to. */
  origin: string;
  frames: FrameHandoff[];
  /** True once no frame is waiting or in flight. */
  finished: boolean;
}

/**
 * How a batch reads on the History tab.
 *
 * - `running`: something is still going out
 * - `needs-you`: finished, and at least one frame did not make it
 * - `cancelled`: stopped by the designer, nothing failed
 * - `sent`: every frame reached Studio
 */
export type BatchStatus = "running" | "needs-you" | "cancelled" | "sent";

const IN_FLIGHT: ReadonlySet<FrameHandoffStatus> = new Set(["waiting", "walking", "uploading"]);

export function isInFlight(status: FrameHandoffStatus): boolean {
  return IN_FLIGHT.has(status);
}

export function batchStatus(batch: HandoffBatch): BatchStatus {
  if (batch.frames.some((frame) => isInFlight(frame.status))) return "running";
  if (batch.frames.some((frame) => frame.status === "failed")) return "needs-you";
  if (batch.frames.some((frame) => frame.status === "cancelled")) return "cancelled";
  return "sent";
}

export interface BatchCounts {
  total: number;
  sent: number;
  failed: number;
  cancelled: number;
  inFlight: number;
}

export function countFrames(batch: HandoffBatch): BatchCounts {
  const counts: BatchCounts = { total: batch.frames.length, sent: 0, failed: 0, cancelled: 0, inFlight: 0 };
  for (const frame of batch.frames) {
    if (frame.status === "sent") counts.sent++;
    else if (frame.status === "failed") counts.failed++;
    else if (frame.status === "cancelled") counts.cancelled++;
    else counts.inFlight++;
  }
  return counts;
}

/** History that are waiting on the designer: the number on the History tab. */
export function needsAttention(batches: readonly HandoffBatch[]): number {
  return batches.filter((batch) => batchStatus(batch) === "needs-you").length;
}

/**
 * Which frames a Re-send should go out again.
 *
 * A batch that left some frames behind re-sends only those: the frames that
 * arrived are already in Studio, and sending them again would start a second
 * agent build on a design nobody changed. A batch that went fine re-sends all of it,
 * because the designer asking for that wants a fresh batch.
 */
export function framesToResend(batch: HandoffBatch): FrameHandoff[] {
  const missed = batch.frames.filter(
    (frame) => frame.status === "failed" || frame.status === "cancelled",
  );
  return missed.length > 0 ? missed : batch.frames;
}

/**
 * The order the History tab reads in: what needs the designer first, then what is
 * still going, then everything else — each newest first. A failed send from this
 * morning must not sit under a successful one from a minute ago.
 */
export function sortBatches(batches: readonly HandoffBatch[]): HandoffBatch[] {
  const rank: Record<BatchStatus, number> = { "needs-you": 0, running: 1, cancelled: 2, sent: 2 };
  return [...batches].sort((a, b) => rank[batchStatus(a)] - rank[batchStatus(b)] || b.at - a.at);
}

export function newBatch(input: {
  id: string;
  at: number;
  fileName: string;
  origin: string;
  frames: ReadonlyArray<{ frameId: string; name: string }>;
}): HandoffBatch {
  return {
    id: input.id,
    at: input.at,
    fileName: input.fileName,
    origin: input.origin,
    frames: input.frames.map((frame) => ({
      frameId: frame.frameId,
      name: frame.name,
      status: "waiting",
      files: 0,
    })),
    finished: false,
  };
}

/** `finished` is derived, never set by hand, so it cannot drift from the frames. */
export function withFinished(batch: HandoffBatch): HandoffBatch {
  const finished = !batch.frames.some((frame) => isInFlight(frame.status));
  return finished === batch.finished ? batch : { ...batch, finished };
}

export function setFrame(
  batch: HandoffBatch,
  frameId: string,
  patch: Partial<Omit<FrameHandoff, "frameId">>,
): HandoffBatch {
  return withFinished({
    ...batch,
    frames: batch.frames.map((frame) => {
      if (frame.frameId !== frameId) return frame;
      const next: FrameHandoff = { ...frame, ...patch };
      // A frame that is not failing any more must not keep its old reason.
      if (next.status !== "failed") delete next.error;
      return next;
    }),
  });
}

/** Mark everything still queued as stopped. In-flight work finishes on its own. */
export function cancelWaiting(batch: HandoffBatch): HandoffBatch {
  return withFinished({
    ...batch,
    frames: batch.frames.map((frame) =>
      frame.status === "waiting" ? { ...frame, status: "cancelled" } : frame,
    ),
  });
}

/**
 * A plugin that closed mid-send left frames "uploading" forever. Whatever did not
 * land is a failure with a reason the designer can act on — Re-send picks it up.
 */
export function settleInterrupted(batch: HandoffBatch): HandoffBatch {
  if (batch.finished && !batch.frames.some((frame) => isInFlight(frame.status))) return batch;
  return withFinished({
    ...batch,
    frames: batch.frames.map((frame) =>
      isInFlight(frame.status)
        ? { ...frame, status: "failed", error: "The plugin closed before this frame finished sending." }
        : frame,
    ),
  });
}

export const MAX_BATCHES = 20;

/** Newest first, capped. */
export function pushBatch(batches: readonly HandoffBatch[], batch: HandoffBatch): HandoffBatch[] {
  return [batch, ...batches.filter((item) => item.id !== batch.id)].slice(0, MAX_BATCHES);
}

export function replaceBatch(batches: readonly HandoffBatch[], batch: HandoffBatch): HandoffBatch[] {
  return batches.map((item) => (item.id === batch.id ? batch : item));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const CLIENT_STORAGE_BATCHES_KEY = "fanos-studio.batches";

const STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "walking",
  "uploading",
  "sent",
  "failed",
  "cancelled",
]);

/**
 * Whatever clientStorage hands back, as batches. Anything malformed is dropped — a
 * history entry from an older build must never stop the plugin from opening.
 */
export function parseBatches(raw: unknown): HandoffBatch[] {
  if (!Array.isArray(raw)) return [];
  const batches: HandoffBatch[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r["id"] !== "string" || typeof r["at"] !== "number" || !Array.isArray(r["frames"])) {
      continue;
    }
    const frames: FrameHandoff[] = [];
    for (const f of r["frames"] as unknown[]) {
      if (!f || typeof f !== "object") continue;
      const frame = f as Record<string, unknown>;
      if (
        typeof frame["frameId"] !== "string" ||
        typeof frame["name"] !== "string" ||
        typeof frame["status"] !== "string" ||
        !STATUSES.has(frame["status"])
      ) {
        continue;
      }
      const parsed: FrameHandoff = {
        frameId: frame["frameId"],
        name: frame["name"],
        status: frame["status"] as FrameHandoffStatus,
        files: typeof frame["files"] === "number" ? frame["files"] : 0,
      };
      if (typeof frame["error"] === "string") parsed.error = frame["error"];
      frames.push(parsed);
    }
    if (frames.length === 0) continue;
    batches.push(
      withFinished({
        id: r["id"],
        at: r["at"],
        fileName: typeof r["fileName"] === "string" ? r["fileName"] : "",
        origin: typeof r["origin"] === "string" ? r["origin"] : "",
        frames,
        finished: r["finished"] === true,
      }),
    );
  }
  return batches.slice(0, MAX_BATCHES);
}

// ---------------------------------------------------------------------------
// The History source
// ---------------------------------------------------------------------------

/**
 * Where the History tab gets its batches.
 *
 * Today that is this plugin's own history. When the control plane has a
 * plugin-facing batches API (after plugin auth), a second implementation merges
 * Studio's status — running, needs approval, report ready — into the same
 * `HandoffBatch`s, and nothing above this interface changes.
 */
export interface BatchesSource {
  list(): Promise<HandoffBatch[]>;
  save(batches: readonly HandoffBatch[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** `4 min ago`. Coarse on purpose: a batch is hours old, not seconds. */
export function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** `Home · Fixtures · Match centre`, trimmed when a batch has many frames. */
export function batchTitle(batch: HandoffBatch, max = 3): string {
  const names = batch.frames.map((frame) => frame.name);
  if (names.length <= max) return names.join(" · ");
  return `${names.slice(0, max).join(" · ")} · +${names.length - max}`;
}

/** Why a batch needs the designer, in one sentence. */
export function batchProblem(batch: HandoffBatch): string {
  const failed = batch.frames.filter((frame) => frame.status === "failed");
  if (failed.length === 0) return "";
  const first = failed[0]!;
  const reason = first.error ? first.error : "didn’t finish uploading";
  if (failed.length === 1) return `${first.name}: ${reason}`;
  return `${failed.length} frames didn’t make it. ${first.name}: ${reason}`;
}

/** `localhost:3000` from `http://localhost:3000/`. */
export function hostOf(origin: string): string {
  return origin.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");
}
