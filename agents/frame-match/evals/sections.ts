/**
 * What the parts of each eval frame ARE, as a person reads the design: its background, its bands
 * (parts that stand alone) and the slots in each (parts that show one kind of data). `pnpm eval
 * sections` scores the section finder against these (`.scratch/page-sections/spec.md`).
 *
 * The IR of each case is copied into `evals/sections/<id>.ir.json`, with the sizes of its pictures
 * in `<id>.plates.json`: the case does not depend on the control plane. Slots are compared by the
 * layers they hold (top-level node ids), not by name.
 */

export interface SlotLabel {
  name: string;
  /** The top-level layers of the slot: heading, content and controls. */
  nodes: string[];
}

export interface SectionsCase {
  id: string;
  what: string;
  /** Layers painted behind the slots. Never a section. */
  background: string[];
  /** Slots under one background are one band. */
  bands: Array<{ slots: SlotLabel[] }>;
}

export const SECTION_CASES: SectionsCase[] = [
  {
    id: "team",
    what: "Team (35:10501): a blue background under a fixtures carousel and the squad with its tabs",
    background: ["35:10502"],
    bands: [
      {
        slots: [
          { name: "the-road-ahead", nodes: ["35:10541"] },
          // heading row with the WOMEN/MEN tabs and View more, the player cards, their arrows
          { name: "the-brave-squad", nodes: ["35:10512", "35:10526", "35:10529"] },
        ],
      },
    ],
  },
  {
    id: "fixtures-list",
    what: "Fixtures (1:6213): a title over three match cards side by side, one slot",
    background: [],
    bands: [{ slots: [{ name: "fixtures", nodes: ["1:6394", "1:6214", "1:6257", "1:6320"] }] }],
  },
  {
    id: "latest-news",
    what: "LATEST NEWS (35:10231): one section, a heading over a list",
    background: [],
    bands: [{ slots: [{ name: "latest-news", nodes: ["35:10232"] }] }],
  },
  {
    id: "videos",
    what: "Videos (35:10611): a background shape under one section",
    background: ["35:10612"],
    bands: [{ slots: [{ name: "videos", nodes: ["35:10613"] }] }],
  },
];
