/**
 * @fanos/dsl — the SDUI vocabulary.
 *
 * The second half of T0. `@fanos/tokens` owns token names and values; this
 * package owns node shapes and consumes those tokens as types.
 *
 * Five consumers derive from here and none may be hand-maintained: the web
 * renderer's prop types, the validator that gates every generated tree, the
 * JSON Schema handed to the codegen agent, Surface Admin's form controls, and
 * the docs.
 */

export { SCHEMA_VERSION } from "./version.js";

// Part 1 — wire format
export {
  childrenOf,
  depths,
  flatten,
  flatNodeSchema,
  flatTreeSchema,
  isSynthetic,
  nodeById,
  reify,
  ReifyError,
  rootOf,
  syntheticSrc,
} from "./flat.js";
export type { FlatNode, FlatTree, Node, ReifyErrorCode } from "./flat.js";

// Part 2 — value wrappers
export {
  ANCHORS,
  isRaw,
  isRespObject,
  isSignedTokenRef,
  isTokenRef,
  PERCENT_RE,
  RATIO_RE,
  raw,
  refCategory,
  respValues,
  SEMVER_REF_RE,
  SIGNED_TOKEN_REF_RE,
  TOKEN_REF_RE,
  unsignRef,
} from "./values.js";
export type {
  Anchor,
  BreakpointKey,
  OffsetValue,
  Percent,
  Raw,
  Resp,
  RespObject,
  SizeValue,
  TokenRef,
  Val,
} from "./values.js";

// Field descriptors — the single source every representation derives from
export {
  ACTION_KINDS,
  actionSchema,
  docTypeOf,
  f,
  field,
  jsonOfField,
  jsonOfFields,
  opt,
  predicateSchema,
  rawSchema,
  req,
  tsOfField,
  tsOfType,
  zodOfField,
  zodOfFields,
} from "./field.js";
export type { Action, Field, Fields, FieldType, JsonContext, JsonSchema, Predicate } from "./field.js";

// Parts 3/4/5 — the vocabulary
export {
  allFields,
  isNodeType,
  LEAF_NODES,
  NODE_SPECS,
  NODE_TYPES,
  nodeSpec,
  STRUCTURAL_NODES,
} from "./nodes/index.js";
export type { NodeSpec } from "./nodes/index.js";
export {
  metaFields,
  placeFields,
  PLATFORMS,
  REPEATER_FORBIDDEN_PROPS,
  REVEALS,
  semanticsFields,
  sizeFields,
  spaceFields,
  universalFields,
  UNIVERSAL_PROP_NAMES,
} from "./universal.js";

// Part 6 — validation
export { analyze, ISSUE_CODES, issuesByCode, validate } from "./validate.js";
export type { Issue, IssueCode, ValidateOptions, ValidationResult } from "./validate.js";
export type { Metrics, RawValueCount } from "./metrics.js";
export { suggestRefs } from "./suggest.js";
export { walkFields, walkProps } from "./walk.js";
export type { LeafVisit, RespVisit, WalkHandlers } from "./walk.js";

// Part 7 — emission
export { emitTypes } from "./emit/types.js";
export { collectRefs, emitJsonSchema, selfReferentialDefs } from "./emit/json-schema.js";
export type { EmitJsonSchemaOptions } from "./emit/json-schema.js";
export { emitDocs } from "./emit/docs.js";

// Subtree signatures and collapse proposals
export {
  normaliseProps,
  stableJson,
  subtreeSignature,
  subtreeSignatures,
  SUBTREE_SIGNATURE_PREFIX,
} from "./subtree-signature.js";
export { sha1Hex } from "./sha1.js";
export { proposeCollapse } from "./collapse.js";
export {
  CONFIDENCE,
  LAYOUT_KINDS,
  LAYOUT_THRESHOLDS,
  confidenceOf,
  carouselConfigSchema,
  gridConfigSchema,
  layoutChoiceSchema,
  tabsConfigSchema,
} from "./layout.js";
export type { CarouselConfig, Confidence, LayoutChoice, LayoutChrome, LayoutIntent, LayoutKind } from "./layout.js";
export { fromPlatformCarousel, toPlatformCarousel } from "./platform-carousel.js";
export type {
  PlatformArrows,
  PlatformCarousel,
  PlatformIndicator,
  PlatformProgress,
  PlatformRead,
  PlatformReadOptions,
  StateLook,
} from "./platform-carousel.js";
export type { CollapseProposal, VaryingContent } from "./collapse.js";
export { applyBindingPlan, hasBindings } from "./bind.js";
export {
  type AtPlaces,
  type ItemPlace,
  type Place,
  type PlaceLook,
  PLACES,
  placesOf,
  positionalLooks,
  propsAtPlace,
} from "./positional.js";
export type { BindingPlan, BindResult, Drift, DriftReason, PlanBinding, PlanCollapse, PlanSet } from "./bind.js";

// Data binding — the ref grammar, pipes, `when`, CAST payloads, the B rules
export {
  absolutize,
  CDN_RATIOS,
  CONDITION_OPS,
  conditionSchema,
  conditionsOf,
  evaluateCondition,
  evaluateWhen,
  fillImageRatio,
  formatDate,
  hasRef,
  lookup,
  mapRefPaths,
  parseRefs,
  PATH_RE,
  PIPES,
  RATIO_SLOT,
  refRegex,
  resolveTemplate,
} from "./binding.js";
export type { Condition, Pipe, PipeSpec, Ref, ResolveOptions, ResolveResult, Scalar } from "./binding.js";
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
// Page state: a choice one section makes and any section reads (`select`, `_page`)
export { choiceValue } from "./binding.js";
export {
  isPagePath,
  PAGE_KEY_RE,
  PAGE_SCOPE,
  pageChoices,
  pageDefaults,
  pageFields,
  FIELD_TYPES,
  pageKeyOf,
  pageKeyOfPath,
  pageReads,
  pageScope,
  pageValueOf,
  readsPage,
  selectOf,
  selectSchema,
  splitPageWhen,
} from "./page.js";
export type { PageChoice, PageField, PageFieldType, PageOption, PageState, Select } from "./page.js";
export { fromCastFlow } from "./cast.js";
export type { CastData, CastPagination } from "./cast.js";
export { checkBindings, checkPipes, inferShape } from "./contract.js";
export type { Shape } from "./contract.js";

// Part 8 — tree operations
export {
  applyCollapse,
  collapseToRepeater,
  insertBefore,
  moveNode,
  removeNode,
  replaceNode,
  setProp,
  TreeOpError,
  wrapIn,
} from "./ops.js";
export type { Binding, CollapseOptions, RemoveOptions } from "./ops.js";

// The property panel of a node: what a person can edit, from the field descriptors
export { panelOf, propIssues, propNamesOf } from "./panel.js";
export type { PanelField, PanelGroup, PanelGroupId } from "./panel.js";
export { measureOf, measureText, readProp, shownValue, storedValue } from "./panel-values.js";
export type { PanelControl } from "./panel-values.js";
