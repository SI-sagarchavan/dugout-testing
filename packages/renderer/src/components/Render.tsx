/**
 * Tree renderer — Server Components only. No "use client".
 *
 * Scope: Box, Stack, Overlay, Carousel, Repeater, Text, Image, Icon, Divider, Button, Input, Checkbox.
 * Other node types render a visible diagnostic placeholder.
 */

import type { ReactNode } from "react";
import type { FlatTree, Node } from "@fanos/dsl";
import {
  childrenOf,
  evaluateWhen,
  lookup,
  pageDefaults,
  propsAtPlace,
  reify,
  rootOf,
  selectOf,
  splitPageWhen,
} from "@fanos/dsl";
import type { NodeRenderContext, RenderConfig } from "../context.js";
import { Box } from "./Box.js";
import { Button } from "./Button.js";
import { Stack } from "./Stack.js";
import { Overlay } from "./Overlay.js";
import { Text } from "./Text.js";
import { Image } from "./Image.js";
import { Icon } from "./Icon.js";
import { Divider } from "./Divider.js";
import { Input } from "./Input.js";
import { Checkbox } from "./Checkbox.js";
import { Carousel } from "./Carousel.js";
import { stateRules } from "../resolve/look.js";
import { splitWhen, withClock } from "../resolve/clock.js";
import { ClockGate, PageChoices, PageGate } from "@fanos/renderer/client";
import { PAGE_SELECTED } from "../resolve/style.js";

export interface RenderProps {
  tree: FlatTree;
  data?: RenderConfig["data"];
  assets?: RenderConfig["assets"];
  themeSlug?: string;
  origin?: RenderConfig["origin"];
  timeZone?: RenderConfig["timeZone"];
  /** The time to draw clocks at, epoch ms. Defaults to now. */
  now?: RenderConfig["now"];
  /** Where the page's choices start, when the host draws several sections (`pageDefaults`). */
  page?: RenderConfig["page"];
  /** Optional root width in px (harness sets this). */
  width?: number;
  /**
   * The width the tree was DESIGNED at, from the Figma frame it came from.
   *
   * A fixed-aspect card is a media object, not a fluid layout: at twice the
   * size everything doubles, type included. Measured on the real pair — the
   * Figma frame is 281px wide with a 36px name (9.25% of width) and the shipped
   * web card is 534px with a ~68px name (8.80%) — the same object at 1.9x.
   *
   * Type tokens are absolute px per breakpoint and correctly do NOT scale with
   * a container, so honouring that at another size means scaling the whole
   * card. Set this and the renderer lays the tree out at its native size and
   * scales the result; leave it unset for a fluid component.
   */
  designWidth?: number;
}

export function Render({ tree, data, assets, themeSlug, origin, timeZone, now, width, designWidth, page }: RenderProps) {
  // Validate structure early — reify throws on broken trees.
  reify(tree);
  const root = rootOf(tree);
  if (!root) return null;

  // Read once: every clock on the page is drawn at the same moment.
  // The choices and fields this tree writes start as drawn, unless the host says otherwise.
  const writes = pageDefaults([tree]);
  const pageState = { ...writes, ...(page ?? {}) };
  const ctx: NodeRenderContext = {
    data,
    assets,
    themeSlug,
    origin,
    timeZone,
    now: now ?? Date.now(),
    page: pageState,
  };
  const scale = width && designWidth && designWidth > 0 ? width / designWidth : 1;
  const scaled = scale !== 1;

  // Aspect comes from the root's own `size.ratio`, so the wrapper never has to
  // guess the design height.
  const ratio = (root.props as { size?: { ratio?: string } }).size?.ratio;
  const [rw, rh] = ratio ? ratio.split("/").map(Number) : [];
  const designHeight =
    designWidth && rw && rh && rw > 0 ? (designWidth * rh) / rw : undefined;

  const inner = <RenderNode node={root} tree={tree} ctx={ctx} />;
  // How each node looks in its states, from the tree's tokens; scoped to this tree.
  const states = stateRules(tree, root.id);

  return (
    <div
      className="fos-root"
      data-fos-theme={themeSlug}
      data-fos-root
      data-fos-tree={root.id}
      {...(scaled ? { "data-fos-scale": scale.toFixed(4) } : {})}
      style={{
        ...(width ? { width: `${width}px` } : {}),
        // Rounded: a 17-digit float in the DOM helps nobody and makes the
        // emitted markup non-deterministic to eyeball.
        ...(scaled && designHeight
          ? { height: `${Number((designHeight * scale).toFixed(4))}px`, overflow: "visible" }
          : {}),
      }}
    >
      {states && <style>{states}</style>}
      {Object.keys(writes).length > 0 && <PageChoices initial={pageState} />}
      {scaled ? (
        <div
          data-fos-scaler
          style={{
            width: `${designWidth}px`,
            ...(designHeight ? { height: `${designHeight}px` } : {}),
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        >
          {inner}
        </div>
      ) : (
        inner
      )}
    </div>
  );
}

/** Resolve a dotted path to an array, for Repeater.over. */
function resolveList(path: string | undefined, data: unknown): unknown[] | undefined {
  if (!path) return undefined;
  const list = lookup(data, path);
  return Array.isArray(list) ? list : undefined;
}

/**
 * The scopes a Repeater draws its children in: one per item of its window, or undefined when
 * there is no list at `over`.
 *
 * `slice` windows the list; `limit` caps it from the front. Either/or, never both — S13 rejects
 * a tree that sets the two, because they answer the same question twice. An index-tiered grid
 * needs the window: one list of six articles drawn as a lead, two features and three briefs,
 * where the tier is decided by POSITION and no field on the item marks it.
 *
 * `Array.prototype.slice` already clamps, so a window past the end of a short list draws what
 * there is rather than throwing — the page renders short instead of not at all, which is the
 * right failure for a section whose CMS came back with four items instead of six.
 */
function repetitions(node: Node, ctx: NodeRenderContext): NodeRenderContext[] | undefined {
  const props = node.props as { over?: string; as?: string; limit?: number; slice?: [number, number] };
  const items = resolveList(props.over, ctx.data);
  if (items === undefined) {
    console.warn(`[fos-render] Repeater "${node.id}" — no list at "${props.over}"`);
    return undefined;
  }
  const capped = Array.isArray(props.slice)
    ? items.slice(props.slice[0], props.slice[1])
    : typeof props.limit === "number"
      ? items.slice(0, props.limit)
      : items;
  const alias = props.as ?? "item";
  // each item's place among those drawn: what a node's `at` reads (the rule every row but the last has)
  return capped.map((item, index) => ({
    ...ctx,
    data: { ...(ctx.data ?? {}), [alias]: item },
    place: { index, count: capped.length },
  }));
}

/** The children a Repeater draws between its items (`separator`), in order. */
function separatorOf(node: Node, kids: Node[]): Node[] {
  const ids = (node.props as { separator?: unknown }).separator;
  if (!Array.isArray(ids)) return [];
  return ids.flatMap((id) => kids.filter((k) => k.id === id));
}

/** A Repeater's children drawn for each item: all but its separator, which a slide has no use for. */
function repeated(node: Node, kids: Node[]): Node[] {
  const separator = separatorOf(node, kids);
  return kids.filter((k) => !separator.includes(k));
}

function RenderNode({ node: given, tree, ctx: outer }: { node: Node; tree: FlatTree; ctx: NodeRenderContext }) {
  // its look at its item's place in the nearest Repeater (`at`); nothing where it is hidden there
  const placed = propsAtPlace(given.props as Record<string, unknown>, outer.place);
  if (placed === undefined) return null;
  const node = placed === given.props ? given : ({ ...given, props: placed } as Node);
  const props = node.props as Record<string, unknown>;
  // A clock is in scope on the node that carries it, its own `when` included.
  const ctx = withClock(props, outer);
  /**
   * `when` gates the node and its whole subtree, in the node's own scope — so
   * inside a Repeater it tests the item: the play badge on a video, the
   * duration chip only when there is a duration. A node that does not draw
   * leaves no box, exactly as fanxp's `WithVisibilityControl` returns null.
   *
   * A condition on a clock changes as time passes, so the browser decides it: the node is drawn,
   * and shown while the clock's conditions hold.
   */
  const when = splitWhen(props.when, ctx);
  // A condition on the page's choices changes as a person chooses, so the browser decides it too:
  // the node is drawn, and shown while it holds; the server's first paint is the page's start.
  const paged = splitPageWhen(when.now, ctx.data);
  if (!evaluateWhen(paged.now, ctx.data)) return null;
  const drawn = <DrawNode node={chosen(node, ctx)} tree={tree} ctx={ctx} />;
  const ticking =
    when.ticking.length === 0 ? (
      drawn
    ) : (
      <ClockGate conditions={when.ticking} clocks={when.clocks} now={ctx.now ?? Date.now()}>
        {drawn}
      </ClockGate>
    );
  if (paged.page.length === 0) return ticking;
  return (
    <PageGate conditions={paged.page} page={ctx.page ?? {}}>
      {ticking}
    </PageGate>
  );
}

/** An option of a page choice, marked when it is the choice the page is drawn at. */
function chosen(node: Node, ctx: NodeRenderContext): Node {
  const select = selectOf(node);
  if (!select) return node;
  return { ...node, props: { ...node.props, [PAGE_SELECTED]: ctx.page?.[select.key] === select.value } } as Node;
}

function DrawNode({
  node,
  tree,
  ctx,
}: {
  node: Node;
  tree: FlatTree;
  ctx: NodeRenderContext;
}) {

  const kids = childrenOf(tree, node.id);
  const childCtxFor = (parentType: string): NodeRenderContext => {
    // A Resp direction carries its base in `base`; default is column.
    const dir = (node.props as { direction?: unknown }).direction;
    const base = typeof dir === "string" ? dir : (dir as { base?: string } | undefined)?.base;
    return {
      ...ctx,
      flexChild: parentType === "Stack",
      flexRow: parentType === "Stack" && base === "row",
      overlayChild: parentType === "Overlay",
    };
  };

  const renderChildren = (parentType: string) =>
    kids.map((child) => (
      <RenderNode key={child.id} node={child} tree={tree} ctx={childCtxFor(parentType)} />
    ));

  switch (node.type) {
    case "Box":
      return (
        <Box node={node} ctx={ctx}>
          {renderChildren("Box")}
        </Box>
      );
    case "Stack":
      return (
        <Stack node={node} ctx={ctx}>
          {renderChildren("Stack")}
        </Stack>
      );
    case "Overlay":
      return (
        <Overlay node={node} ctx={ctx}>
          {renderChildren("Overlay")}
        </Overlay>
      );
    case "Text":
      return <Text node={node} ctx={ctx} />;
    case "Button":
      return <Button node={node} ctx={ctx} />;
    case "Image":
      return <Image node={node} ctx={ctx} />;
    case "Icon":
      return <Icon node={node} ctx={ctx} />;
    case "Divider":
      return <Divider node={node} ctx={ctx} />;
    case "Input":
      return <Input node={node} ctx={ctx} />;
    case "Checkbox":
      return <Checkbox node={node} ctx={ctx} />;
    case "Repeater": {
      const scopes = repetitions(node, ctx);
      if (scopes === undefined) return null;
      // The separator is drawn once between two items, in the Repeater's own scope, not in each.
      const separator = separatorOf(node, kids);
      const each = repeated(node, kids);
      return (
        <>
          {scopes.map((scope, i) => (
            // `display: contents` keeps each repetition out of the layout box
            // tree — a Repeater under a Stack must place its children directly
            // into that flex flow, not inside a wrapper. The attribute still
            // gives the repair loop something to map a diff region onto.
            <div key={`${node.id}-${i}`} style={{ display: "contents" }} data-fos-repeat={i} data-fos-repeat-of={node.id}>
              {i > 0 ? separator.map((between) => <RenderNode key={between.id} node={between} tree={tree} ctx={ctx} />) : null}
              {each.map((child) => (
                <RenderNode
                  key={child.id}
                  node={child}
                  tree={tree}
                  // A fragment passes its OWN context down: its children are flex
                  // items of the Repeater's parent, not of the Repeater.
                  ctx={scope}
                />
              ))}
            </div>
          ))}
        </>
      );
    }
    case "Carousel": {
      // Each child is one slide, and each repetition of a Repeater child is one slide. A slide is
      // a box of its own, so what is in it lays out as in any block, not as a flex item.
      const slideCtx: NodeRenderContext = { ...ctx, flexChild: false, flexRow: false, overlayChild: false };
      const slides: ReactNode[] = [];
      for (const child of kids) {
        if (child.type === "Repeater") {
          const scopes = repetitions(child, slideCtx) ?? [];
          scopes.forEach((scope, i) => {
            slides.push(
              <div key={`${child.id}-${i}`} className="swiper-slide" data-fos-repeat={i} data-fos-repeat-of={child.id}>
                {repeated(child, childrenOf(tree, child.id)).map((grand) => (
                  <RenderNode key={grand.id} node={grand} tree={tree} ctx={scope} />
                ))}
              </div>,
            );
          });
        } else {
          slides.push(
            <div key={child.id} className="swiper-slide">
              <RenderNode node={child} tree={tree} ctx={slideCtx} />
            </div>,
          );
        }
      }
      return <Carousel node={node} ctx={ctx} slides={slides} />;
    }
    default:
      console.warn(`[fos-render] node type "${node.type}" is out of scope for phase 1`);
      return (
        <div data-fos-id={node.id} data-fos-type={node.type} data-fos-unsupported>
          {renderChildren(node.type)}
        </div>
      );
  }
}
