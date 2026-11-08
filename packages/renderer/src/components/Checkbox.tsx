/**
 * Checkbox — a box a person ticks.
 *
 * A real `<input type="checkbox">`, laid over the drawn box and not seen, so a click, Space, a
 * screen reader and a sent form all work with no code of ours. What is seen is the design: the box
 * is the node's own surface and size, and the tick is the `check` glyph in `mark` at `markSize`, shown while the
 * input is checked (a structural rule, `:checked + .fos-checkbox-mark`).
 *
 * Ticked, the node is in its `active` state, else `inactive`, so `states.active` is the ticked
 * box's look, as a chosen tab's is. The server draws the state it starts at; the page's listener
 * (`PageChoices`, `@fanos/renderer/client`) moves it and writes `_page.<key>`: "true" or "false".
 */

import type { Node } from "@fanos/dsl";
import { cssVar } from "@fanos/tokens";
import { resolveNode } from "../resolve/style.js";
import { formatUnresolvedWarnings, interpolate } from "../resolve/data.js";
import type { NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";
import { renderIcon } from "./icons.js";

export function Checkbox({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild, parentDirection: ctx.flexRow ? "row" : "column" });

  const key = typeof props.key === "string" ? props.key : node.id;
  // The page's value wins: a host that drew another section with this key already ticked it.
  const page = ctx.page?.[key];
  const checked = page !== undefined ? page === "true" : props.checked === true;

  let label: string | undefined;
  if (typeof props.label === "string") {
    const { value, unresolved } = interpolate(props.label, ctx.data, { timeZone: ctx.timeZone });
    for (const w of formatUnresolvedWarnings(node.id, "label", unresolved)) console.warn(w);
    label = value;
  }
  const markSize = typeof props.markSize === "number" && props.markSize > 0 ? props.markSize : 10;
  const mark = typeof props.mark === "string" && props.mark.startsWith("color.") ? cssVar(props.mark) : undefined;

  return (
    <span
      className={`${resolved.className} fos-checkbox`}
      style={styleToReact(resolved.style)}
      data-fos-id={node.id}
      data-fos-type="Checkbox"
      {...resolved.dataAttrs}
      data-fos-state={checked ? "active" : "inactive"}
    >
      <input
        className="fos-checkbox-input"
        type="checkbox"
        name={key}
        defaultChecked={checked}
        {...(typeof props.value === "string" ? { value: props.value } : {})}
        {...(label ? { "aria-label": label } : {})}
        {...(props.required === true ? { required: true } : {})}
        {...(props.disabled === true ? { disabled: true } : {})}
        data-fos-field={key}
      />
      {renderIcon("check", { size: markSize, color: mark ?? "currentColor", className: "fos-checkbox-mark" })}
    </span>
  );
}
