/**
 * Sends: what the Send tab shows while frames go out, and what the Runs tab
 * remembers afterwards.
 *
 * One click on Send is a *run*: a list of frames, each sent on its own (one Send
 * per frame, so one agent run per frame). The run record is the one structure
 * both tabs draw — the Send tab while it is in flight, Runs once it is history —
 * and it is plain data so it survives `figma.clientStorage` and postMessage.
 *
 * Status here is what the plugin can honestly know: whether the files left the
 * building. What Studio does with them afterwards (matching, binding, waiting
 * for approval) is not visible from here until a runs API exists, and a status
 * the plugin invented would be worse than none. `RunsSource` is the seam that
 * API plugs into.
 *
 * PURE. No Figma, no DOM.
 */

export type FrameSendStatus =
  /** Queued behind another frame of the same run. */
  | "waiting"
  /** Reading the frame: IR, screenshots, marked assets. */
  | "walking"
  /** The files are on their way to Studio. */
  | "uploading"
  | "sent"
  | "failed"
  /** The designer stopped the run before this frame went out. */
  | "cancelled";

export interface FrameSend {
  frameId: string;
  name: string;
  status: FrameSendStatus;
  /** Files in the send: the IR, the screenshots, the marked assets. 0 until walked. */
  files: number;
  /** Why it failed. Only set when `status` is `failed`. */
  error?: string;
}

export interface RunRecord {
  id: string;
  /** ms since epoch, when the designer pressed Send. */
  at: number;
  fileName: string;
  /** The Studio the frames were sent to. */
  origin: string;
  frames: FrameSend[];
  /** True once no frame is waiting or in flight. */
  finished: boolean;
}

/**
 * How a run reads on the Runs tab.
 *
 * - `running`: something is still going out
 * - `needs-you`: finished, and at least one frame did not make it
 * - `cancelled`: stopped by the designer, nothing failed
 * - `sent`: every frame reached Studio
 */
export type RunStatus = "running" | "needs-you" | "cancelled" | "sent";

const IN_FLIGHT: ReadonlySet<FrameSendStatus> = new Set(["waiting", "walking", "uploading"]);

export function isInFlight(status: FrameSendStatus): boolean {
  return IN_FLIGHT.has(status);
}

export function runStatus(run: RunRecord): RunStatus {
  if (run.frames.some((frame) => isInFlight(frame.status))) return "running";
  if (run.frames.some((frame) => frame.status === "failed")) return "needs-you";
  if (run.frames.some((frame) => frame.status === "cancelled")) return "cancelled";
  return "sent";
}

export interface RunCounts {
  total: number;
  sent: number;
  failed: number;
  cancelled: number;
  inFlight: number;
}

export function countFrames(run: RunRecord): RunCounts {
  const counts: RunCounts = { total: run.frames.length, sent: 0, failed: 0, cancelled: 0, inFlight: 0 };
  for (const frame of run.frames) {
    if (frame.status === "sent") counts.sent++;
    else if (frame.status === "failed") counts.failed++;
    else if (frame.status === "cancelled") counts.cancelled++;
    else counts.inFlight++;
  }
  return counts;
}

/** Runs that are waiting on the designer: the number on the Runs tab. */
export function needsAttention(runs: readonly RunRecord[]): number {
  return runs.filter((run) => runStatus(run) === "needs-you").length;
}

/**
 * Which frames a Re-send should go out again.
 *
 * A run that left some frames behind re-sends only those: the frames that
 * arrived are already in Studio, and sending them again would start a second
 * agent run on a design nobody changed. A run that went fine re-sends all of it,
 * because the designer asking for that wants a fresh run.
 */
export function framesToResend(run: RunRecord): FrameSend[] {
  const missed = run.frames.filter(
    (frame) => frame.status === "failed" || frame.status === "cancelled",
  );
  return missed.length > 0 ? missed : run.frames;
}

/**
 * The order the Runs tab reads in: what needs the designer first, then what is
 * still going, then everything else — each newest first. A failed send from this
 * morning must not sit under a successful one from a minute ago.
 */
export function sortRuns(runs: readonly RunRecord[]): RunRecord[] {
  const rank: Record<RunStatus, number> = { "needs-you": 0, running: 1, cancelled: 2, sent: 2 };
  return [...runs].sort((a, b) => rank[runStatus(a)] - rank[runStatus(b)] || b.at - a.at);
}

export function newRun(input: {
  id: string;
  at: number;
  fileName: string;
  origin: string;
  frames: ReadonlyArray<{ frameId: string; name: string }>;
}): RunRecord {
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
export function withFinished(run: RunRecord): RunRecord {
  const finished = !run.frames.some((frame) => isInFlight(frame.status));
  return finished === run.finished ? run : { ...run, finished };
}

export function setFrame(
  run: RunRecord,
  frameId: string,
  patch: Partial<Omit<FrameSend, "frameId">>,
): RunRecord {
  return withFinished({
    ...run,
    frames: run.frames.map((frame) => {
      if (frame.frameId !== frameId) return frame;
      const next: FrameSend = { ...frame, ...patch };
      // A frame that is not failing any more must not keep its old reason.
      if (next.status !== "failed") delete next.error;
      return next;
    }),
  });
}

/** Mark everything still queued as stopped. In-flight work finishes on its own. */
export function cancelWaiting(run: RunRecord): RunRecord {
  return withFinished({
    ...run,
    frames: run.frames.map((frame) =>
      frame.status === "waiting" ? { ...frame, status: "cancelled" } : frame,
    ),
  });
}

/**
 * A plugin that closed mid-send left frames "uploading" forever. Whatever did not
 * land is a failure with a reason the designer can act on — Re-send picks it up.
 */
export function settleInterrupted(run: RunRecord): RunRecord {
  if (run.finished && !run.frames.some((frame) => isInFlight(frame.status))) return run;
  return withFinished({
    ...run,
    frames: run.frames.map((frame) =>
      isInFlight(frame.status)
        ? { ...frame, status: "failed", error: "The plugin closed before this frame finished sending." }
        : frame,
    ),
  });
}

export const MAX_RUNS = 20;

/** Newest first, capped. */
export function pushRun(runs: readonly RunRecord[], run: RunRecord): RunRecord[] {
  return [run, ...runs.filter((item) => item.id !== run.id)].slice(0, MAX_RUNS);
}

export function replaceRun(runs: readonly RunRecord[], run: RunRecord): RunRecord[] {
  return runs.map((item) => (item.id === run.id ? run : item));
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const CLIENT_STORAGE_RUNS_KEY = "fanos-studio.runs";

const STATUSES: ReadonlySet<string> = new Set([
  "waiting",
  "walking",
  "uploading",
  "sent",
  "failed",
  "cancelled",
]);

/**
 * Whatever clientStorage hands back, as runs. Anything malformed is dropped — a
 * history entry from an older build must never stop the plugin from opening.
 */
export function parseRuns(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  const runs: RunRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r["id"] !== "string" || typeof r["at"] !== "number" || !Array.isArray(r["frames"])) {
      continue;
    }
    const frames: FrameSend[] = [];
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
      const parsed: FrameSend = {
        frameId: frame["frameId"],
        name: frame["name"],
        status: frame["status"] as FrameSendStatus,
        files: typeof frame["files"] === "number" ? frame["files"] : 0,
      };
      if (typeof frame["error"] === "string") parsed.error = frame["error"];
      frames.push(parsed);
    }
    if (frames.length === 0) continue;
    runs.push(
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
  return runs.slice(0, MAX_RUNS);
}

// ---------------------------------------------------------------------------
// The Runs source
// ---------------------------------------------------------------------------

/**
 * Where the Runs tab gets its runs.
 *
 * Today that is this plugin's own history. When the control plane has a
 * plugin-facing runs API (after plugin auth), a second implementation merges
 * Studio's status — running, needs approval, report ready — into the same
 * `RunRecord`s, and nothing above this interface changes.
 */
export interface RunsSource {
  list(): Promise<RunRecord[]>;
  save(runs: readonly RunRecord[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** `4 min ago`. Coarse on purpose: a run is hours old, not seconds. */
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

/** `Home · Fixtures · Match centre`, trimmed when a run has many frames. */
export function runTitle(run: RunRecord, max = 3): string {
  const names = run.frames.map((frame) => frame.name);
  if (names.length <= max) return names.join(" · ");
  return `${names.slice(0, max).join(" · ")} · +${names.length - max}`;
}

/** Why a run needs the designer, in one sentence. */
export function runProblem(run: RunRecord): string {
  const failed = run.frames.filter((frame) => frame.status === "failed");
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
