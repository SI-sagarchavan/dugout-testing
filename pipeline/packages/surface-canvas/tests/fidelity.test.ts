import { describe, expect, it } from "vitest";
import { imageDetailOf, maskOf, renderBoxOf, textAlignOf } from "../src/fidelity";
import { IR_VERSIONS, parseFrameIRDocument, safeParseFrameIRDocument } from "../src/ir/index";
import { document, looseText, node, resetIds } from "./health-fixtures";

describe("textAlignOf", () => {
  it("records alignment that is not the default", () => {
    expect(textAlignOf({ textAlignHorizontal: "RIGHT", textAlignVertical: "CENTER" })).toEqual({
      textAlignHorizontal: "RIGHT",
      textAlignVertical: "CENTER",
    });
    expect(textAlignOf({ textAlignHorizontal: "CENTER" })).toEqual({
      textAlignHorizontal: "CENTER",
    });
    expect(textAlignOf({ textAlignHorizontal: "JUSTIFIED" })).toEqual({
      textAlignHorizontal: "JUSTIFIED",
    });
  });

  it("writes nothing for the defaults, or for a node that has none", () => {
    expect(textAlignOf({ textAlignHorizontal: "LEFT", textAlignVertical: "TOP" })).toEqual({});
    expect(textAlignOf({})).toEqual({});
    expect(textAlignOf({ textAlignHorizontal: "sideways" })).toEqual({});
  });
});

describe("renderBoxOf", () => {
  it("is the box the pixels fill, which a shadow makes larger than the layout box", () => {
    expect(renderBoxOf({ absoluteRenderBounds: { x: 90, y: 95, width: 120, height: 70 } })).toEqual(
      { x: 90, y: 95, w: 120, h: 70 },
    );
  });

  it("has no answer for a layer that paints nothing, or a node type without bounds", () => {
    expect(renderBoxOf({ absoluteRenderBounds: null })).toBeUndefined();
    expect(renderBoxOf({})).toBeUndefined();
    expect(renderBoxOf({ absoluteRenderBounds: { x: 0, y: 0, width: 0, height: 5 } })).toBeUndefined();
  });
});

describe("maskOf", () => {
  it("says a layer is a mask, and of what kind", () => {
    expect(maskOf({ isMask: true, maskType: "ALPHA" })).toEqual({ isMask: true, maskType: "ALPHA" });
    expect(maskOf({ isMask: true })).toEqual({ isMask: true });
    expect(maskOf({ isMask: true, maskType: "nonsense" })).toEqual({ isMask: true });
  });

  it("says nothing for a layer that is not one", () => {
    expect(maskOf({ isMask: false, maskType: "ALPHA" })).toBeUndefined();
    expect(maskOf({})).toBeUndefined();
  });
});

describe("imageDetailOf", () => {
  const transform = [
    [0.5, 0, 0.25],
    [0, 0.8123456789, 0.1],
  ];

  it("keeps the crop window for a CROP fill, rounded", () => {
    expect(imageDetailOf({ scaleMode: "CROP", imageTransform: transform })).toEqual({
      transform: [
        [0.5, 0, 0.25],
        [0, 0.81235, 0.1],
      ],
    });
  });

  it("ignores a transform on a fit that places the bitmap itself", () => {
    expect(imageDetailOf({ scaleMode: "FILL", imageTransform: transform })).toEqual({});
    expect(imageDetailOf({ scaleMode: "FIT", imageTransform: transform })).toEqual({});
  });

  it("records a turned bitmap, a tile scale and a paint opacity, and only when not default", () => {
    expect(
      imageDetailOf({ scaleMode: "TILE", scalingFactor: 0.5, rotation: 90, opacity: 0.6 }),
    ).toEqual({ scalingFactor: 0.5, rotation: 90, opacity: 0.6 });
    expect(imageDetailOf({ scaleMode: "FILL", rotation: 0, opacity: 1, scalingFactor: 2 })).toEqual(
      {},
    );
  });
});

describe("IR 1.9.0", () => {
  it("is a known version, and the new fields survive a parse", () => {
    resetIds();
    const root = node({ id: "1:1", children: [node({ id: "1:2", type: "TEXT", text: looseText() })] });
    root.geometry.renderBbox = { x: -4, y: -2, w: 108, h: 58 };
    const text = root.children[0]!;
    text.text = { ...looseText(), textAlignHorizontal: "RIGHT", textAlignVertical: "CENTER" };
    text.isMask = true;
    text.maskType = "ALPHA";
    root.image = {
      fit: "CROP",
      hasImageFill: true,
      transform: [
        [1, 0, 0],
        [0, 1, 0],
      ],
      opacity: 0.5,
    };

    expect(IR_VERSIONS).toContain("1.9.0");
    const parsed = parseFrameIRDocument(JSON.parse(JSON.stringify(document(root))));
    expect(parsed.root.geometry.renderBbox).toEqual({ x: -4, y: -2, w: 108, h: 58 });
    expect(parsed.root.children[0]?.text?.textAlignHorizontal).toBe("RIGHT");
    expect(parsed.root.children[0]?.isMask).toBe(true);
    expect(parsed.root.children[0]?.maskType).toBe("ALPHA");
    expect(parsed.root.image?.transform?.[1]).toEqual([0, 1, 0]);
    expect(parsed.root.image?.opacity).toBe(0.5);
  });

  it("still parses a 1.8.0 document that has none of them, and means what it did", () => {
    resetIds();
    const old = JSON.parse(JSON.stringify(document(node({ id: "1:1" }))));
    old.irVersion = "1.8.0";
    const parsed = safeParseFrameIRDocument(old);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.root.geometry.renderBbox).toBeUndefined();
      expect(parsed.data.root.isMask).toBeUndefined();
    }
  });

  it("refuses a malformed crop transform", () => {
    resetIds();
    const doc = JSON.parse(JSON.stringify(document(node({ id: "1:1" }))));
    doc.root.image = { fit: "CROP", hasImageFill: true, transform: [[1, 0]] };
    expect(safeParseFrameIRDocument(doc).success).toBe(false);
  });
});
