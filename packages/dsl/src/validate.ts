/**
 * Part 6 — Validator.
 *
 * Gates every generated tree before render. Structural and token problems are
 * ERRORS; quality signals are COUNTED and never block.
 *
 * PURE. No filesystem, no process, no clock — `tests/purity.test.ts` enforces
 * it, and every validator test runs against in-memory objects.
 */

import type { Registry } from "@fanos/tokens";
import { DEFAULT_BREAKPOINTS } from "@fanos/tokens";
import { reify, ReifyError, rootOf, type FlatNode, type FlatTree } from "./flat.js";
import { allFields, nodeSpec } from "./nodes/index.js";
import { analyze, type Metrics } from "./metrics.js";
import { suggestRefs } from "./suggest.js";
import { isRespObject, isSignedTokenRef, respValues, refCategory, SEMVER_REF_RE, unsignRef } from "./values.js";
import { LAYOUT_PROP_NAMES, REPEATER_FORBIDDEN_PROPS } from "./universal.js";
import { walkProps } from "./walk.js";
import { zodOfFields, type FieldType } from "./field.js";
import { type BindingCheckOptions, checkBindings, checkPipes } from "./contract.js";
import { PAGE_KEY_RE, selectOf } from "./page.js";
import { checkMachine } from "./machine/tree.js";

export const ISSUE_CODES = [
  "S1", // reify failed: cycle, orphan, multi-root, idx gap
  "S2", // unknown node type
  "S3", // missing or duplicate id; missing src
  "S4", // Section not a direct child of root
  "S5", // Repeater carrying layout/space/size/surface props
  "S6", // place.anchor under a parent that cannot position it
  "S7", // place.span on a node whose parent is not Grid
  "S8", // Overlay child with no place.anchor
  "S9", // Grid columns:"auto" with no minItemWidth
  "S10", // Carousel with control nodes among its children (warning, heuristic)
  "S11", // Custom.ref not name@semver
  "S12", // a prop failed its schema (shape, not resolution)
  "S13", // Repeater.slice is malformed, out of order, or paired with limit
  "S14", // two Repeaters over one source draw overlapping slices (warning)
  "S15", // Carousel options Swiper cannot combine, or a moving carousel nobody can pause
  "S16", // controlFor names no Carousel, or a carousel has two of one control part
  "S17", // a page choice sets one value twice, starts twice, or has one option; a field's key is not one name or is written twice
  "S18", // a section's machine is not one, or not on the root; a node sends an event nobody handles, reads $state with no machine, or a Repeater draws state
  "S19", // a link (href, or a Button that navigates) inside another link, or href on a Button
  "T1", // token ref does not resolve
  "T2", // Text.style is not a TypeToken
  "T3", // Resp<> wrapper around a TypeToken
  "T4", // Resp breakpoint key not in the tokens package config
  "T5", // ref resolves but is the wrong category for this prop
  // B — bindings. B4 runs always; the rest need `data` (see contract.ts).
  "B1", // a {path}, Repeater.over or when.path is not in the data
  "B2", // wrong shape for the slot: an object drawn as text, over not a list
  "B3", // path walks through a CAST page key (data.1) — bind items (warning)
  "B4", // unknown pipe or wrong arity; date on a non-date (warning)
  "B5", // ISO date drawn without a date pipe (warning)
  "B6", // CDN {{RATIO}} image with no ratio (warning) or an unservable one
  "B7", // when compares against a type the field never holds (warning)
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];

/** The nodes drawn as a link when they have `href` (S19): a card, a box, a text. */
const LINKABLE = new Set(["Stack", "Box", "Overlay", "Text"]);

export interface Issue {
  code: IssueCode;
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
  /** Dotted prop path within the node, when the issue is prop-scoped. */
  path?: string;
  /** Up to three near misses from the token registry (T1). */
  suggestions?: string[];
}

export interface ValidateOptions {
  registry: Registry;
  /** Defaults to the tokens package's own breakpoint keys. */
  breakpointKeys?: readonly string[];
  /**
   * A sample of the data this tree will be rendered against — for a CAST
   * template, `{ news: fromCastFlow(response) }`. When given, every binding is
   * checked against it (B1–B7). Without it only the pipe names are (B4).
   */
  data?: unknown;
  /** The page choices other sections write, for an `over` that reads one (`checkBindings`). */
  choices?: BindingCheckOptions["choices"];
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  metrics: Metrics;
}

export { analyze };

/** Field kinds whose value must be a resolvable ref of a specific category. */
function expectedCategory(type: FieldType): string | undefined {
  if (type.k === "token") return type.category;
  if (type.k === "val") return type.category;
  if (type.k === "size" || type.k === "offset") return "space";
  return undefined;
}

/**
 * Parents that can honour `place.anchor`.
 *
 * An Overlay positions every child (S8). A Stack positions the children that
 * opt OUT of its flow — which is a real thing Figma does and CSS does: an
 * absolutely-positioned child of an auto-layout frame anchors to that frame
 * while its siblings keep flowing. Both render as `position: absolute` inside a
 * `position: relative` box, and the renderer has always drawn it correctly.
 *
 * Excluding Stack forced the compiler to demote any auto-layout frame with one
 * absolute child to an Overlay — which anchors ALL of its children and throws
 * the row away. On the fixtures page that collapsed a 333px button row to 72px
 * and shifted its subtree by 262px.
 *
 * Leaves and fragments stay excluded, which is the rule's real job: a Repeater
 * under a Stack makes its children flex items, and an anchor there is
 * meaningless because nothing will ever honour it.
 */
const ANCHORS_CHILDREN = new Set(["Overlay", "Stack"]);

/** Chrome a Carousel renders itself; finding it as a child node is the S10 smell. */
const CONTROL_SRC_RE = /(arrow|chevron|dot|pagination|counter|prev|next)/i;

export function validate(tree: FlatTree, options: ValidateOptions): ValidationResult {
  const { registry } = options;
  const breakpointKeys = options.breakpointKeys ?? Object.keys(DEFAULT_BREAKPOINTS);
  const issues: Issue[] = [];
  const add = (issue: Issue) => issues.push(issue);

  // --- S3: identity ------------------------------------------------------
  const seenIds = new Set<string>();
  for (const node of tree.nodes) {
    if (!node.id) {
      add({ code: "S3", severity: "error", message: "node is missing an id" });
    } else if (seenIds.has(node.id)) {
      add({ code: "S3", severity: "error", nodeId: node.id, message: `duplicate node id "${node.id}"` });
    } else {
      seenIds.add(node.id);
    }
    if (!node.src) {
      add({
        code: "S3",
        severity: "error",
        nodeId: node.id,
        message: `node "${node.id}" is missing src — every node needs a Figma origin (or a synthetic: id) for the repair loop`,
      });
    }
  }

  // --- S1: the tree must fold up -----------------------------------------
  try {
    reify(tree);
  } catch (error) {
    const detail = error instanceof ReifyError ? error : undefined;
    add({
      code: "S1",
      severity: "error",
      message: `tree does not reify: ${error instanceof Error ? error.message : String(error)}`,
      ...(detail?.nodeIds[0] ? { nodeId: detail.nodeIds[0] } : {}),
    });
  }

  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  const root = rootOf(tree);
  const parentOf = (node: FlatNode): FlatNode | undefined =>
    node.parent === null ? undefined : byId.get(node.parent);

  /**
   * The node whose layout actually governs this one.
   *
   * A fragment emits its children into ITS parent's layout, so a Repeater under
   * an Overlay makes its children Overlay children — they need `place.anchor`
   * — while a Repeater under a Stack makes them flex items, where an anchor is
   * meaningless. Comparing against the immediate parent gets both backwards.
   */
  const layoutParentOf = (node: FlatNode): FlatNode | undefined => {
    let p = parentOf(node);
    while (p && nodeSpec(p.type)?.fragment) p = parentOf(p);
    return p;
  };

  // Paths already explained by a token rule, so the shape check does not
  // report the same value twice in different words.
  const covered = new Set<string>();
  const cover = (nodeId: string, path: string) => covered.add(`${nodeId} ${path}`);

  for (const node of tree.nodes) {
    const spec = nodeSpec(node.type);

    // --- S2 -------------------------------------------------------------
    if (!spec) {
      add({
        code: "S2",
        severity: "error",
        nodeId: node.id,
        message: `unknown node type "${node.type}"`,
      });
      continue;
    }

    const parent = parentOf(node);
    const layoutParent = layoutParentOf(node);
    const fields = allFields(spec);

    // --- S4 -------------------------------------------------------------
    if (node.type === "Section" && root && node.id !== root.id && node.parent !== root.id) {
      add({
        code: "S4",
        severity: "error",
        nodeId: node.id,
        message: `Section "${node.id}" must be a direct child of the root, not of "${node.parent}"`,
      });
    }

    // --- S5 -------------------------------------------------------------
    if (spec.fragment) {
      const forbidden = [...REPEATER_FORBIDDEN_PROPS, ...LAYOUT_PROP_NAMES];
      for (const prop of forbidden) {
        if (node.props[prop] === undefined) continue;
        add({
          code: "S5",
          severity: "error",
          nodeId: node.id,
          path: prop,
          message: `${node.type} is a fragment and cannot carry "${prop}" — it emits its children into the parent's layout and has no box of its own`,
        });
        cover(node.id, prop);
      }
    }

    // --- S6 / S7 / S8 ----------------------------------------------------
    const place = node.props["place"] as Record<string, unknown> | undefined;
    if (place && typeof place === "object") {
      if (place["anchor"] !== undefined && !ANCHORS_CHILDREN.has(layoutParent?.type ?? "")) {
        add({
          code: "S6",
          severity: "error",
          nodeId: node.id,
          path: "place.anchor",
          message: `place.anchor needs a parent that can position it (${[...ANCHORS_CHILDREN].join(" or ")}); "${node.id}" lays out under ${layoutParent ? `a ${layoutParent.type}` : "no parent"}`,
        });
      }
      if (place["span"] !== undefined && layoutParent?.type !== "Grid") {
        add({
          code: "S7",
          severity: "error",
          nodeId: node.id,
          path: "place.span",
          message: `place.span is only meaningful under a Grid; "${node.id}" lays out under ${layoutParent ? `a ${layoutParent.type}` : "no parent"}`,
        });
      }
    }

    // Every Overlay child must say where it goes. Two siblings sharing an
    // anchor is LEGAL — that is how layering works — and is never flagged.
    if (layoutParent?.type === "Overlay" && (!place || (place as Record<string, unknown>)["anchor"] === undefined)) {
      add({
        code: "S8",
        severity: "error",
        nodeId: node.id,
        path: "place.anchor",
        message: `"${node.id}" is an Overlay child and must declare place.anchor`,
      });
    }

    // --- S13 -------------------------------------------------------------
    if (node.type === "Repeater") {
      const slice = node.props["slice"];
      if (slice !== undefined) {
        /**
         * `[start, end)`, end exclusive, both integers, start before end; or `[start]`, from start to
         * the end of the list, however long it grows (the cards after a mosaic, as LOAD MORE adds
         * pages).
         *
         * The field language has no tuple kind, so the schema accepts
         * `number[]` and the arity is checked here. Reported as one issue per
         * problem rather than a single "invalid slice", because "end is not
         * after start" and "you also set limit" are different mistakes with
         * different fixes.
         */
        if (!Array.isArray(slice) || (slice.length !== 2 && slice.length !== 1)) {
          add({
            code: "S13",
            severity: "error",
            nodeId: node.id,
            path: "slice",
            message: `Repeater.slice must be [start, end) or [start], got ${JSON.stringify(slice)}`,
          });
          cover(node.id, "slice");
        } else {
          const [start, end] = slice as [unknown, unknown];
          const open = slice.length === 1;
          const ints = typeof start === "number" && (open || typeof end === "number");
          if (!ints || !Number.isInteger(start) || (!open && !Number.isInteger(end))) {
            add({
              code: "S13",
              severity: "error",
              nodeId: node.id,
              path: "slice",
              message: `Repeater.slice takes integers, got ${JSON.stringify(slice)}`,
            });
            cover(node.id, "slice");
          } else {
            if (start < 0) {
              add({
                code: "S13",
                severity: "error",
                nodeId: node.id,
                path: "slice.0",
                message: `Repeater.slice starts at ${start}; a slice cannot begin before the list does`,
              });
              cover(node.id, "slice");
            }
            if (!open && (end as number) <= start) {
              add({
                code: "S13",
                severity: "error",
                nodeId: node.id,
                path: "slice.1",
                message: `Repeater.slice is [${start}, ${end}) — end is exclusive and must be past start, so this draws nothing`,
              });
              cover(node.id, "slice");
            }
          }
        }

        if (node.props["limit"] !== undefined) {
          add({
            code: "S13",
            severity: "error",
            nodeId: node.id,
            path: "slice",
            message: `Repeater "${node.id}" sets both slice and limit — they cap the same list two different ways, so the tree has two answers for how many items to draw`,
          });
          cover(node.id, "slice");
          cover(node.id, "limit");
        }
      }
    }

    // --- S9 --------------------------------------------------------------
    if (node.type === "Grid") {
      const columns = node.props["columns"];
      const usesAuto = columns === "auto" || (isRespObject(columns) && Object.values(columns).includes("auto"));
      if (usesAuto && node.props["minItemWidth"] === undefined) {
        add({
          code: "S9",
          severity: "error",
          nodeId: node.id,
          path: "minItemWidth",
          message: `Grid "${node.id}" uses columns:"auto" and must declare minItemWidth`,
        });
      }
    }

    // --- S19 --------------------------------------------------------------
    // A link inside a link is not HTML: the browser closes the outer one. A Button links by its action.
    if (node.type === "Button" && node.props["href"] !== undefined) {
      add({
        code: "S19",
        severity: "error",
        nodeId: node.id,
        path: "href",
        message: `Button "${node.id}" has href: a Button goes somewhere by its action ({ kind: "navigate", href })`,
      });
    }
    if (node.props["href"] !== undefined && node.type !== "Button" && !LINKABLE.has(node.type)) {
      add({
        code: "S19",
        severity: "error",
        nodeId: node.id,
        path: "href",
        message: `${node.type} "${node.id}" cannot be a link: put href on the card or box around it (a Stack, Box, Overlay or Text)`,
      });
    }
    const links = (n: FlatNode) =>
      n.props["href"] !== undefined ||
      (n.type === "Button" && (n.props["action"] as { kind?: unknown } | undefined)?.kind === "navigate");
    if (links(node)) {
      for (let up = parentOf(node); up; up = parentOf(up)) {
        if (up.props["href"] === undefined) continue;
        add({
          code: "S19",
          severity: "error",
          nodeId: node.id,
          message: `"${node.id}" links inside "${up.id}", which links already: a link cannot hold another; keep one of them`,
        });
        break;
      }
    }

    // --- S10 (heuristic, warning) ----------------------------------------
    if (node.type === "Carousel") {
      for (const child of tree.nodes.filter((n) => n.parent === node.id)) {
        if (child.type !== "Icon" && child.type !== "Button") continue;
        if (!CONTROL_SRC_RE.test(child.src)) continue;
        add({
          code: "S10",
          severity: "warning",
          nodeId: child.id,
          message: `"${child.id}" (${child.type}, src ${child.src}) looks like a control, and a Carousel's children are its slides — put it beside the carousel (in an Overlay) or inside a slide, with controlFor`,
        });
      }
    }

    // --- S15 -------------------------------------------------------------
    if (node.type === "Carousel") {
      const controls = tree.nodes.filter(
        (n) => (n.props["controlFor"] as { target?: unknown } | undefined)?.target === node.id,
      );
      checkCarousel(node, controls.length > 0, add);
    }

    // --- S16 -------------------------------------------------------------
    const control = node.props["controlFor"] as { target?: unknown; part?: unknown } | undefined;
    if (control && typeof control.target === "string") {
      const target = tree.nodes.find((n) => n.id === control.target);
      if (target?.type !== "Carousel") {
        add({
          code: "S16",
          severity: "error",
          nodeId: node.id,
          path: "controlFor.target",
          message: target
            ? `"${node.id}" controls "${control.target}", which is a ${target.type}, not a Carousel`
            : `"${node.id}" controls "${control.target}", which is not in the tree`,
        });
      } else if (
        // Inside a slide, every slide may carry its own: an arrow pair drawn on each card.
        !descendsFrom(tree, node, control.target) &&
        tree.nodes.some(
          (n) =>
            n.id !== node.id &&
            (n.props["controlFor"] as { target?: unknown; part?: unknown } | undefined)?.target === control.target &&
            (n.props["controlFor"] as { part?: unknown }).part === control.part &&
            tree.nodes.findIndex((m) => m.id === n.id) < tree.nodes.findIndex((m) => m.id === node.id),
        )
      ) {
        add({
          code: "S16",
          severity: "error",
          nodeId: node.id,
          path: "controlFor.part",
          message: `Carousel "${control.target}" already has a ${String(control.part)} control`,
        });
      }
      const extra = control as { format?: unknown; of?: unknown };
      if (extra.format !== undefined && control.part !== "counter") {
        add({ code: "S16", severity: "warning", nodeId: node.id, path: "controlFor.format", message: `format is for a counter; "${node.id}" is ${String(control.part)}` });
      }
      if (extra.of !== undefined && control.part !== "progress") {
        add({ code: "S16", severity: "warning", nodeId: node.id, path: "controlFor.of", message: `of is for a progress bar; "${node.id}" is ${String(control.part)}` });
      }
      if (control.part === "counter" && node.type !== "Text") {
        add({ code: "S16", severity: "error", nodeId: node.id, path: "controlFor.part", message: `a counter is a Text; "${node.id}" is a ${node.type}` });
      }
    }

    // --- S17 -------------------------------------------------------------
    // One choice is its options in this tree: each value once, and one place the page starts.
    const rawKey = (node.props["select"] as { key?: unknown } | undefined)?.key;
    if (typeof rawKey === "string" && !PAGE_KEY_RE.test(rawKey)) {
      add({ code: "S17", severity: "error", nodeId: node.id, path: "select.key", message: `"${rawKey}" is read as _page.${rawKey}: a key is one name, letters, digits and _` });
    }
    const select = selectOf(node);
    if (select) {
      const siblings = tree.nodes.filter((n) => n.id !== node.id && selectOf(n)?.key === select.key);
      if (siblings.some((n) => selectOf(n)!.value === select.value)) {
        add({ code: "S17", severity: "error", nodeId: node.id, path: "select.value", message: `two options of "${select.key}" set it to "${select.value}": pressing either does the same` });
      }
      if (select.initial && siblings.some((n) => selectOf(n)!.initial && tree.nodes.indexOf(n) < tree.nodes.indexOf(node))) {
        add({ code: "S17", severity: "error", nodeId: node.id, path: "select.initial", message: `"${select.key}" already starts at another option: one option is initial` });
      }
      if (siblings.length === 0) {
        add({ code: "S17", severity: "warning", nodeId: node.id, path: "select", message: `"${select.key}" has one option, so there is nothing to choose` });
      }
    }

    // A field (Input, Checkbox) writes its key as a choice does: one name, and one writer per tree.
    if (node.type === "Input" || node.type === "Checkbox") {
      const fieldKey = node.props["key"];
      if (typeof fieldKey === "string" && !PAGE_KEY_RE.test(fieldKey)) {
        add({ code: "S17", severity: "error", nodeId: node.id, path: "key", message: `"${fieldKey}" is read as _page.${fieldKey}: a key is one name, letters, digits and _` });
      } else if (typeof fieldKey === "string") {
        const writers = tree.nodes.filter(
          (n) => n.id !== node.id && (((n.type === "Input" || n.type === "Checkbox") && n.props["key"] === fieldKey) || selectOf(n)?.key === fieldKey),
        );
        if (writers.some((n) => tree.nodes.indexOf(n) < tree.nodes.indexOf(node))) {
          add({ code: "S17", severity: "error", nodeId: node.id, path: "key", message: `"${fieldKey}" is already written by "${writers[0]!.id}": each field has a key of its own` });
        }
      }
    }

    // --- S11 -------------------------------------------------------------
    if (node.type === "Custom") {
      const ref = node.props["ref"];
      if (typeof ref !== "string" || !SEMVER_REF_RE.test(ref)) {
        add({
          code: "S11",
          severity: "error",
          nodeId: node.id,
          path: "ref",
          message: `Custom.ref must be \`name@1.2.3\`, got ${JSON.stringify(ref)}`,
        });
        cover(node.id, "ref");
      }
    }

    // --- T rules ----------------------------------------------------------
    walkProps(fields, node.props, {
      resp: ({ path, keys, field }) => {
        // T3 — a Resp wrapper where the value is already responsive.
        if (!field.resp) {
          const isTypeToken = field.type.k === "token" && field.type.category === "type";
          if (isTypeToken) {
            add({
              code: "T3",
              severity: "error",
              nodeId: node.id,
              path,
              message: `${path} is a type token and is ALREADY responsive — @fanos/tokens resolves type.* per breakpoint, so wrapping it in { base, ${breakpointKeys.join(", ")} } creates two competing responsive systems`,
            });
          } else {
            add({
              code: "S12",
              severity: "error",
              nodeId: node.id,
              path,
              message: `${path} is not a responsive prop but was given a { base, … } wrapper`,
            });
          }
          cover(node.id, path);
          return;
        }
        // T4 — keys must match the tokens package config exactly.
        for (const key of keys) {
          if (key === "base" || breakpointKeys.includes(key)) continue;
          add({
            code: "T4",
            severity: "error",
            nodeId: node.id,
            path: `${path}.${key}`,
            message: `"${key}" is not a breakpoint in the tokens package config (have: base, ${breakpointKeys.join(", ")})`,
          });
          cover(node.id, path);
        }
      },

      leaf: ({ path, value, type }) => {
        // T2 — Text.style must be a type token, whatever else it resolves to.
        if (node.type === "Text" && path === "style") {
          if (typeof value !== "string" || refCategory(value) !== "type") {
            add({
              code: "T2",
              severity: "error",
              nodeId: node.id,
              path,
              message: `Text.style must be a TypeToken, got ${JSON.stringify(value)}`,
              suggestions: typeof value === "string" ? suggestRefs(registry, `type.${value}`) : [],
            });
            cover(node.id, path);
            return;
          }
        }

        if (typeof value !== "string" || !isSignedTokenRef(value)) return;

        const wanted = expectedCategory(type);
        const actual = refCategory(value);

        // T5 — resolves, but not the kind of token this prop takes.
        if (wanted && actual && actual !== wanted) {
          add({
            code: "T5",
            severity: "error",
            nodeId: node.id,
            path,
            message: `${path} takes a ${wanted} token, got a ${actual} token (${value})`,
            suggestions: suggestRefs(registry, `${wanted}.${unsignRef(value).slice(actual.length + 1)}`),
          });
          cover(node.id, path);
          return;
        }

        // T1 — the ref is well-formed and the right category, but nothing has it.
        if (!registry.has(unsignRef(value))) {
          add({
            code: "T1",
            severity: "error",
            nodeId: node.id,
            path,
            message: `"${value}" on node "${node.id}" at ${path} does not resolve in this theme`,
            suggestions: suggestRefs(registry, value),
          });
          cover(node.id, path);
        }
      },
    });

    // --- S12: shape ------------------------------------------------------
    const parsed = zodOfFields(fields, breakpointKeys).safeParse(node.props);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.join(".");
        // An unrecognized-key issue lists its keys rather than pointing at one,
        // so it is dropped only once EVERY key it names has been explained.
        if (issue.code === "unrecognized_keys") {
          const unexplained = issue.keys.filter((k) => !covered.has(`${node.id} ${k}`));
          if (unexplained.length === 0) continue;
        }
        // Suppress anything a token rule already explained in better words.
        if (covered.has(`${node.id} ${path}`)) continue;
        if ([...covered].some((key) => key.startsWith(`${node.id} ${path}.`))) continue;
        add({
          code: "S12",
          severity: "error",
          nodeId: node.id,
          path: path || undefined,
          message: `${path || "props"}: ${issue.message}`,
        });
      }
    }
  }

  // --- S14: two windows on one list ---------------------------------------
  /**
   * Repeaters over the same source whose slices overlap.
   *
   * Cross-node, so it runs after the per-node pass. Scoped to the whole tree
   * rather than to literal siblings, because the shape it exists to catch is
   * never siblings: an index-tiered grid puts its lead, its features and its
   * briefs in three different columns, and a rule that only looked at one
   * parent's children would never fire on the page it was written for.
   *
   * A warning, not an error. Drawing article #2 in two places is nearly always
   * a slip, and occasionally a deliberate "featured, and also in the list".
   */
  for (const [source, windows] of slicesBySource(tree)) {
    for (let i = 0; i < windows.length; i++) {
      for (let j = i + 1; j < windows.length; j++) {
        const a = windows[i]!;
        const b = windows[j]!;
        if (a.start >= b.end || b.start >= a.end) continue;
        add({
          code: "S14",
          severity: "warning",
          nodeId: a.nodeId,
          path: "slice",
          message: `slice ${shown(a)} overlaps "${b.nodeId}"'s ${shown(b)} over the same "${source}" — items ${Math.max(a.start, b.start)}..${Number.isFinite(Math.min(a.end, b.end)) ? Math.min(a.end, b.end) - 1 : "the end"} are drawn twice`,
        });
      }
    }
  }

  // --- B: bindings ---------------------------------------------------------
  issues.push(...checkPipes(tree));
  issues.push(...checkMachine(tree));
  if (options.data !== undefined) issues.push(...checkBindings(tree, options.data, options.choices ? { choices: options.choices } : {}));

  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // Reported whether or not the tree validates: a broken tree's raw-value
    // count is still the number design ops needs, and withholding it would make
    // the metric disappear exactly when someone is working on the tree.
    metrics: analyze(tree),
  };
}

interface SliceWindow {
  nodeId: string;
  start: number;
  end: number;
}

const shown = (w: SliceWindow) => (Number.isFinite(w.end) ? `[${w.start}, ${w.end})` : `[${w.start}]`);

/** Well-formed slices, grouped by the list they window. Malformed ones are S13's. */
function slicesBySource(tree: FlatTree): Map<string, SliceWindow[]> {
  const out = new Map<string, SliceWindow[]>();
  for (const node of tree.nodes) {
    if (node.type !== "Repeater") continue;
    const over = node.props["over"];
    const slice = node.props["slice"];
    if (typeof over !== "string" || !Array.isArray(slice) || (slice.length !== 2 && slice.length !== 1)) continue;
    // an open slice, `[start]`, runs to the end of the list
    const [start, end = Number.POSITIVE_INFINITY] = slice as [unknown, unknown];
    if (typeof start !== "number" || typeof end !== "number" || end <= start) continue;
    const list = out.get(over) ?? [];
    list.push({ nodeId: node.id, start, end });
    out.set(over, list);
  }
  return out;
}

export function issuesByCode(result: ValidationResult, code: IssueCode): Issue[] {
  return [...result.errors, ...result.warnings].filter((i) => i.code === code);
}

/**
 * S15 — Carousel options that Swiper cannot honour together.
 *
 * Each of these is schema-legal and silently wrong at runtime: Swiper drops
 * `rewind` under `loop`, refuses `grid.rows` with `loop`, draws a vertical
 * slider with no height as a zero-height box, and forces one slide per view
 * for the stacking effects. The validator says so before a person sees it.
 *
 * The last check is accessibility, not Swiper: content that moves by itself
 * must be pausable (WCAG 2.2.2). Pausing on hover is the default; a carousel
 * that turns it off and has no controls at some width cannot be stopped there.
 */
function checkCarousel(node: FlatNode, hasControls: boolean, add: (issue: Issue) => void): void {
  const p = node.props;
  const error = (path: string, message: string) =>
    add({ code: "S15", severity: "error", nodeId: node.id, path, message });
  const warn = (path: string, message: string) =>
    add({ code: "S15", severity: "warning", nodeId: node.id, path, message });

  if (p["loop"] === true && p["rewind"] === true) {
    error("rewind", `Carousel "${node.id}" sets both loop and rewind; Swiper ignores rewind under loop. Pick one`);
  }
  if (p["loop"] === true && respValues(p["rows"]).some((r) => typeof r === "number" && r > 1)) {
    error("rows", `Carousel "${node.id}" has rows > 1 with loop; Swiper's grid cannot loop`);
  }
  if (p["direction"] === "vertical") {
    const h = (p["size"] as { h?: unknown } | undefined)?.h;
    if (h === undefined || respValues(h).some((v) => v === "auto" || v === "full" || (typeof v === "string" && v.endsWith("%")))) {
      error("direction", `Carousel "${node.id}" is vertical without a fixed size.h; a vertical slider has no height of its own`);
    }
  }
  const effectProp = p["effect"];
  const effect = typeof effectProp === "object" && effectProp !== null ? (effectProp as { kind?: unknown }).kind : effectProp;
  if (effect === "fade" || effect === "cube" || effect === "flip" || effect === "cards") {
    if (respValues(p["slidesPerView"]).some((v) => v !== 1)) {
      warn("slidesPerView", `Carousel "${node.id}" uses effect "${effect}", which shows one slide at a time; slidesPerView is treated as 1`);
    }
  }
  const autoplay = p["autoplay"];
  if (autoplay && typeof autoplay === "object" && (autoplay as { pauseOnHover?: unknown }).pauseOnHover === false) {
    if (!hasControls) {
      warn("autoplay.pauseOnHover", `Carousel "${node.id}" autoplays, does not pause on hover and has no controls; moving content must be pausable (WCAG 2.2.2)`);
    }
  }
}

/** Is `node` inside the subtree of `ancestorId`? */
function descendsFrom(tree: FlatTree, node: FlatNode, ancestorId: string): boolean {
  const byId = new Map(tree.nodes.map((n) => [n.id, n]));
  for (let p = node.parent; p; p = byId.get(p)?.parent ?? null) if (p === ancestorId) return true;
  return false;
}
