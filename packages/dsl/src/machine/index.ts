/**
 * Interaction state: a machine per section (XState v5, written as JSON), a page of them, and what
 * nodes read. Browser-safe: `@fanos/dsl/runtime` re-exports all of it.
 *
 * - `schema.ts`    what a machine is, as JSON
 * - `expr.ts`      the expression language of guards, `assign`, `computed`, `exports`
 * - `interpret.ts` the spec as an XState machine, stepped by its pure transitions
 * - `system.ts`    a page's machines: exports, events between sections, the host's `$user`/`$route`
 * - `issues.ts`    what the validator says about one machine and a page of them
 * - `when.ts`      a node's `when` split into what the server decides and what the browser does
 */

export * from "./schema.js";
export {
  deepEqual,
  evaluate,
  EXPR_OPS,
  ExprError,
  exprIssues,
  exprReads,
  isTruthy,
  LAMBDA_OPS,
  readPath,
  writePath,
} from "./expr.js";
export type { Expr, ExprIssue, Json } from "./expr.js";
export {
  doneInvoke,
  errorInvoke,
  handlesEvent,
  hasAlways,
  initialStep,
  MachineError,
  restoreContext,
  resumeEffects,
  statePaths,
  step,
  targetPath,
} from "./interpret.js";
export type { MachineEffect, MachineEnv, MachineSnapshot, StateValue, Step } from "./interpret.js";
export {
  addMachine,
  createSystem,
  dispatch,
  isLivePath,
  isStatePath,
  LIVE_ROOTS,
  pageValues,
  removeMachine,
  restoreMachine,
  resumeSystem,
  setPageValue,
  STATE_ROOTS,
  stateScope,
  systemSnapshot,
} from "./system.js";
export type { DispatchOptions, HostState, MachineEntry, PageSystem, SystemEffect, SystemSnapshot, SystemStep } from "./system.js";
export { machineIssues, systemIssues } from "./issues.js";
export type { MachineIssue, PageIssue } from "./issues.js";
