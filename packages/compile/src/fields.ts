/**
 * Form fields: which drawn boxes a person types in or ticks.
 *
 * A static frame of a form draws a text field as a bordered box with grey words in it and a
 * checkbox as a small square beside a line of text, and the compiler drew exactly that: a box and
 * a glyph nobody could use. This reads the same IR for what gives a field away, so the node is
 * emitted as an `Input` or a `Checkbox` (`@fanos/dsl`) in the look the frame drew.
 *
 * - **a checkbox**: a square of 12–32px, drawn as a box (its own stroke, or a plate that covers it
 *   with a stroke or fill) that is not a circle (that is a radio), holding nothing but at most a
 *   small mark (the tick), beside text in its row. A drawn tick says it is ticked.
 * - **a text field**: a single line of text in a box 28–72px tall and at least three times as
 *   wide, drawn with a stroke or a plate, the text centred on the box's height and starting at
 *   its start (not centred: that is a button's label), with no other text in the box except a
 *   button's, and a placeholder's colour (a `disable` grey), or its words ("Your Email Address")
 *   in a bordered box.
 *
 * A component named `atom_checkbox` or `atom_input` is one whatever its shape (`primitives.ts`).
 *
 * PURE. Same document in, same map out.
 */

import type { FrameIRDocument, FrameIRNode } from "@fanos/surface-canvas/ir";
import { layoutBox } from "./geometry.js";
import type { PrimitiveMap } from "./classify.js";

export interface CheckboxPlan {
  type: "Checkbox";
  /** The tick drawn in the box: the box is drawn ticked. */
  mark?: FrameIRNode;
  /** What the text beside it says, its accessible name. */
  label?: string;
}

export interface InputPlan {
  type: "Input";
  /** The box the field is drawn as: the text's parent. */
  box: FrameIRNode;
  /** The plate that paints it, when the box is a group: the field's own rectangle. */
  plate: FrameIRNode;
  /** px from the text's start to where typing stops: the button in the field, or the far padding. */
  width: number;
}

export type FieldPlan = CheckboxPlan | InputPlan;

/** IR node id → what it is. A checkbox's is its box; a field's is its placeholder text. */
export type FieldMap = ReadonlyMap<string, FieldPlan>;

const CHECKBOX_PX = { min: 12, max: 32 };
const FIELD_H = { min: 28, max: 72 };
/** Words a placeholder says, and an empty field's grey. */
const PLACEHOLDER_WORDS = /\b(your|enter|e-?mail|name|search|phone|mobile|number|password|post ?code|zip|address|type|message|first|last|surname|city|country|dd|mm|yyyy)\b/i;
const PLACEHOLDER_TONE = /(disable|placeholder|hint|low)/i;
const TOL = 4;

const box = (n: FrameIRNode) => n.geometry.bbox;
const square = (n: FrameIRNode) => {
  const { w, h } = layoutBox(n);
  return Math.abs(w - h) <= 2 && w >= CHECKBOX_PX.min && w <= CHECKBOX_PX.max;
};
const holdsText = (n: FrameIRNode): boolean => n.text !== undefined || (n.children ?? []).some(holdsText);
const textOf = (n: FrameIRNode): string | undefined =>
  n.text?.characters ?? (n.children ?? []).map(textOf).find((t) => t !== undefined);
const declared = (n: FrameIRNode, primitives: PrimitiveMap, as: string) =>
  n.componentKey !== undefined && primitives[n.componentKey] === as;

/** A child that covers its parent: the rectangle Figma draws a group's box as. */
function coveringPlate(n: FrameIRNode): FrameIRNode | undefined {
  const outer = box(n);
  return (n.children ?? []).find((c) => {
    const b = box(c);
    return (
      (c.fill !== null || c.stroke !== null) &&
      (c.children ?? []).length === 0 &&
      c.text === undefined &&
      Math.abs(b.x - outer.x) <= 1 &&
      Math.abs(b.y - outer.y) <= 1 &&
      b.w >= outer.w * 0.9 &&
      b.h >= outer.h * 0.9
    );
  });
}

/** A circle is a radio button or a dot, not a box. */
const round = (n: FrameIRNode) => {
  const r = n.radius?.value ?? 0;
  return r >= layoutBox(n).w / 2 - 0.5;
};

function checkbox(n: FrameIRNode, parent: FrameIRNode | undefined, primitives: PrimitiveMap): CheckboxPlan | undefined {
  const named = declared(n, primitives, "Checkbox");
  if (!named && (!square(n) || n.text !== undefined || n.image !== undefined)) return undefined;
  const kids = n.children ?? [];
  const plate = n.stroke !== null ? n : coveringPlate(n);
  // a drawn box: a rectangle (it has corners) or a frame, never a stroked glyph's path
  if (!named && (!plate || round(plate) || !(plate.radius !== null || plate.type === "FRAME" || /rect|box|check/i.test(plate.name)))) {
    return undefined;
  }
  // nothing in it but the tick
  const marks = kids.filter((c) => c !== plate);
  if (!named && (marks.length > 1 || marks.some((c) => holdsText(c) || c.image !== undefined))) return undefined;
  const mark = marks[0];
  if (mark && !named) {
    const m = layoutBox(mark);
    const b = layoutBox(n);
    if (m.w > b.w * 0.9 && m.h > b.h * 0.9) return undefined;
  }
  // beside its words: a sibling with text in the same row
  const label = (parent?.children ?? []).filter((s) => s !== n && holdsText(s)).map(textOf).find(Boolean);
  if (!named && label === undefined) return undefined;
  return { type: "Checkbox", ...(mark ? { mark } : {}), ...(label ? { label: label.replace(/\s+/g, " ").trim().slice(0, 200) } : {}) };
}

function input(t: FrameIRNode, parent: FrameIRNode | undefined, primitives: PrimitiveMap): InputPlan | undefined {
  if (!t.text || !parent) return undefined;
  const named = declared(parent, primitives, "Input");
  const plate = parent.stroke !== null || parent.fill !== null ? parent : coveringPlate(parent);
  if (!plate) return undefined;
  const field = box(parent);
  const own = box(t);
  if (!named) {
    if (field.h < FIELD_H.min || field.h > FIELD_H.max || field.w < field.h * 3) return undefined;
    if ((t.text.lines ?? 1) > 1 || t.text.characters.length > 48) return undefined;
    if (Math.abs(own.y + own.h / 2 - (field.y + field.h / 2)) > TOL) return undefined;
    if (own.x - field.x > field.w / 2) return undefined;
    // a field's words start at its start; a centred label is a button's
    if (t.text.textAlignHorizontal === "CENTER" || t.text.textAlignHorizontal === "RIGHT") return undefined;
    // an empty field's grey, or a placeholder's words in a bordered box
    const placeholder =
      PLACEHOLDER_TONE.test(t.fill?.tokenRef ?? "") || (PLACEHOLDER_WORDS.test(t.text.characters) && plate.stroke !== null);
    if (!placeholder) return undefined;
    // no other words in the box, but a button's
    const others = (parent.children ?? []).filter((c) => c !== t && holdsText(c));
    if (others.some((c) => !(c.componentKey && primitives[c.componentKey] === "Button"))) return undefined;
  }
  // typing stops before what sits after the text in the box (its button), or at the far padding
  const start = own.x;
  const after = (parent.children ?? [])
    .filter((c) => c !== t && c !== plate && box(c).x >= own.x + own.w - 1)
    .map((c) => box(c).x);
  const end = after.length > 0 ? Math.min(...after) - (start - field.x) / 2 : field.x + field.w - (start - field.x);
  return { type: "Input", box: parent, plate, width: Math.max(own.w, Math.round((end - start) * 10) / 10) };
}

/** Every form field the document draws. */
export function detectFields(doc: FrameIRDocument, primitives: PrimitiveMap = {}): FieldMap {
  const out = new Map<string, FieldPlan>();
  (function walk(n: FrameIRNode, parent: FrameIRNode | undefined): void {
    const asCheckbox = parent ? checkbox(n, parent, primitives) : undefined;
    if (asCheckbox) {
      out.set(n.id, asCheckbox);
      return;
    }
    const asInput = input(n, parent, primitives);
    if (asInput) out.set(n.id, asInput);
    for (const child of n.children ?? []) walk(child, n);
  })(doc.root, undefined);
  return out;
}

/** A field's page key from what it says: "Your Email Address" → `email`. */
export function fieldKey(words: string | undefined, type: FieldPlan["type"]): string {
  const w = (words ?? "").toLowerCase();
  if (type === "Checkbox") {
    if (/(agree|terms|consent|privacy|hear from|marketing|offers|newsletter|updates|subscribe)/.test(w)) return "consent";
    return "checkbox";
  }
  if (/e-?mail/.test(w)) return "email";
  if (/(phone|mobile|tel)/.test(w)) return "phone";
  if (/password/.test(w)) return "password";
  if (/search/.test(w)) return "search";
  if (/(post ?code|zip)/.test(w)) return "postcode";
  if (/first name/.test(w)) return "first_name";
  if (/(last name|surname)/.test(w)) return "last_name";
  if (/name/.test(w)) return "name";
  return "text";
}

/** What an Input takes, from what its placeholder says. */
export function inputKind(words: string): { kind?: string; autocomplete?: string } {
  const w = words.toLowerCase();
  if (/e-?mail/.test(w)) return { kind: "email", autocomplete: "email" };
  if (/(phone|mobile)/.test(w)) return { kind: "tel", autocomplete: "tel" };
  if (/password/.test(w)) return { kind: "password", autocomplete: "current-password" };
  if (/search/.test(w)) return { kind: "search" };
  if (/(post ?code|zip)/.test(w)) return { autocomplete: "postal-code" };
  if (/first name/.test(w)) return { autocomplete: "given-name" };
  if (/(last name|surname)/.test(w)) return { autocomplete: "family-name" };
  if (/name/.test(w)) return { autocomplete: "name" };
  return {};
}
