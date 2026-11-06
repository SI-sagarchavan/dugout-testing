/**
 * `@fanos/dsl/runtime` — what a page needs in the browser to read data as the server does: the
 * ref grammar, pipes, `when`, and clocks. Nothing here reaches `@fanos/tokens` (which reads theme
 * files from disk), so a client bundle can take it. The main entry re-exports all of it.
 */

export {
  conditionsOf,
  evaluateCondition,
  evaluateWhen,
  lookup,
  parseRefs,
  refRegex,
  resolveTemplate,
} from "./binding.js";
export type { Condition, Predicate, ResolveOptions, ResolveResult } from "./binding.js";
export {
  CLOCK_UNITS,
  clockAlias,
  clockInstant,
  clockSchema,
  clockScope,
  clockTick,
  clockUnits,
  clockValues,
  parseInstant,
} from "./clock.js";
export type { Clock, ClockScope, ClockUnit, ClockValues } from "./clock.js";

// Reading and writing a prop as the property panel shows it (the panel itself is `panelOf`, server side)
export { measureOf, measureText, readProp, shownValue, storedValue } from "./panel-values.js";
export type { PanelControl } from "./panel-values.js";
