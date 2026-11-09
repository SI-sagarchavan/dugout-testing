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
  /** The IR file it reads, when it is another case's (`<ir>.ir.json`); its own id otherwise. */
  ir?: string;
  /** Designer notes added to the IR before the finder reads it (ticket 03's marks). */
  annotations?: Array<{
    id: string;
    targetId: string;
    targetName: string;
    kind: string;
    text: string;
  }>;
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
    id: "team-marked",
    ir: "team",
    what: "Team, with the designer's marks: a Background note on D_Team, a Section note on each part",
    annotations: [
      { id: "m1", targetId: "35:10502", targetName: "D_Team", kind: "background", text: "pattern" },
      {
        id: "m2",
        targetId: "35:10541",
        targetName: "Group",
        kind: "section",
        text: "The Road Ahead",
      },
      {
        id: "m3",
        targetId: "35:10512",
        targetName: "heading",
        kind: "section",
        text: "The Brave Squad",
      },
      {
        id: "m4",
        targetId: "35:10529",
        targetName: "cards",
        kind: "section",
        text: "The Brave Squad",
      },
    ],
    background: ["35:10502"],
    bands: [
      {
        slots: [
          { name: "the-road-ahead", nodes: ["35:10541"] },
          { name: "the-brave-squad", nodes: ["35:10512", "35:10526", "35:10529"] },
        ],
      },
    ],
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
