/**
 * Input — a field a person types in.
 *
 * A real `<input>`, so focus, typing, the keyboard a phone shows, autofill and a sent form all
 * work with no code of ours. Its box is the universal surface, space and size, drawn as the design
 * drew the field; the text is the `style` type token in `tone`, and the placeholder is coloured by
 * `placeholderTone` through a custom property the stylesheet reads (`::placeholder` cannot take an
 * inline style).
 *
 * What is typed is the page's under `key` (`_page.<key>`): the page's listener (`PageChoices`,
 * `@fanos/renderer/client`) writes it on each keystroke. The server draws the field at what the
 * page starts at, so the first paint is the design.
 */

import type { Node } from "@fanos/dsl";
import { cssClassName, cssVar } from "@fanos/tokens";
import { resolveNode } from "../resolve/style.js";
import { formatUnresolvedWarnings, interpolate } from "../resolve/data.js";
import { localeOf, type NodeRenderContext } from "../context.js";
import { styleToReact } from "./dom.js";

const KINDS = new Set(["text", "email", "tel", "number", "password", "search", "url"]);

/** A bound string, read as a label is. */
function text(node: Node, prop: string, value: unknown, ctx: NodeRenderContext): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.includes("{")) return value;
  const { value: out, unresolved } = interpolate(value, ctx.data, localeOf(ctx));
  for (const w of formatUnresolvedWarnings(node.id, prop, unresolved)) console.warn(w);
  return out;
}

export function Input({ node, ctx }: { node: Node; ctx: NodeRenderContext }) {
  const props = node.props as Record<string, unknown>;
  const resolved = resolveNode(props, { flexChild: ctx.flexChild, parentDirection: ctx.flexRow ? "row" : "column" });

  const key = typeof props.key === "string" ? props.key : node.id;
  const kind = typeof props.kind === "string" && KINDS.has(props.kind) ? props.kind : "text";
  const placeholder = text(node, "placeholder", props.placeholder, ctx);
  // The page's value wins: a host that drew another section with this key already typed in it.
  const value = ctx.page?.[key] ?? text(node, "value", props.value, ctx) ?? "";
  const label = text(node, "label", props.label, ctx) ?? placeholder;

  const style: Record<string, string> = { ...resolved.style };
  if (typeof props.tone === "string" && props.tone.startsWith("color.")) style.color = cssVar(props.tone);
  if (typeof props.placeholderTone === "string" && props.placeholderTone.startsWith("color.")) {
    style["--fos-placeholder"] = cssVar(props.placeholderTone);
  }

  const styleToken = typeof props.style === "string" && props.style.startsWith("type.") ? props.style : undefined;
  const classes = [resolved.className, "fos-input", styleToken ? cssClassName("type", styleToken.slice("type.".length)) : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <input
      className={classes}
      style={styleToReact(style)}
      type={kind}
      name={key}
      defaultValue={value}
      {...(placeholder ? { placeholder } : {})}
      {...(label ? { "aria-label": label } : {})}
      {...(typeof props.autocomplete === "string" ? { autoComplete: props.autocomplete } : {})}
      {...(props.required === true ? { required: true } : {})}
      {...(props.disabled === true ? { disabled: true } : {})}
      data-fos-id={node.id}
      data-fos-type="Input"
      data-fos-field={key}
      {...resolved.dataAttrs}
    />
  );
}
