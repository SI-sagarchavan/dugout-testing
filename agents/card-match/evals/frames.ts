/**
 * The Sends the eval runs on. Each is a stored export in the local control plane, so the eval
 * needs the trial stack up. `kind` says what the frame is there to catch.
 */
/**
 * Designs the agent was NOT tuned on. Nothing in the code was changed because of how one of them
 * looked, so a number here says whether a fix helps a design nobody has examined. They are not in
 * the live eval, because some score badly for reasons no fix has addressed yet, and they would hold
 * the gate shut. `pnpm card-match:measure` prints them next to the tuned frames.
 */
export const HOLDOUT = [
  { id: "ho-header", exportId: "e02bac4a-8d12-47d0-86c8-859294648575", kind: "a site header" },
  {
    id: "ho-frame-101626",
    exportId: "56e052d3-6df3-4ec7-a2f3-2d928fb3cca8",
    kind: "57 pictures in one frame",
  },
  {
    id: "ho-standings",
    exportId: "afe8edaf-68db-4dc4-b0d8-67d9bc6e3793",
    kind: "a table from another design system's variables",
  },
  {
    id: "ho-frame-1984079082",
    exportId: "58bb6f9f-b37f-453e-a985-2a4523677a28",
    kind: "a wide frame, a screenshot covering 74%",
  },
  {
    id: "ho-merchandise",
    exportId: "8e4e6b10-3918-45fd-b599-ed3d42dee6de",
    kind: "a merchandise strip",
  },
  { id: "ho-tickets", exportId: "9e42efa9-6aae-4d59-9e0f-cf099327e924", kind: "a ticket block" },
  {
    id: "ho-spider",
    exportId: "7baeccb9-8438-4b49-b01e-743d68eac7d9",
    kind: "a graph with a raw gradient",
  },
  { id: "ho-live", exportId: "11cc39ad-f94a-4e7e-8553-1ab9e869ad05", kind: "a thin live bar" },
] as const;

export const FRAMES = [
  {
    id: "fixtures-strip",
    exportId: "f27b85b5-2feb-46af-8fed-7206a9be613b",
    kind: "a screenshot of the whole frame, gradients and crests",
  },
  {
    id: "video-card",
    exportId: "8a17f238-d3da-467d-8bed-48a01f7a3a3a",
    kind: "a photo clipped by its card, with no image in the export",
  },
  {
    id: "news-later",
    exportId: "843a1e35-52be-40d7-830b-a0ac4c271e23",
    kind: "screenshots a few pixels larger than their frames",
  },
  {
    id: "fixtures-inner",
    exportId: "f1340847-a331-4b97-84ab-1d94fe77913e",
    kind: "the same strip sent as inner frames, one screenshot taller than its layer by its overflow",
  },
  {
    id: "player-card",
    exportId: "151e2131-3667-4d38-8d59-ace490964f7d",
    kind: "layers of masked art, a centred name and a round badge",
  },
  {
    id: "player-strip",
    exportId: "07c3b434-12c3-41b6-99cb-bb0367d8e554",
    kind: "five player cards in a row, with names doubled and a blank fifth card",
  },
  {
    id: "latest-news",
    exportId: "17b6e7a4-4a97-4794-abee-bc35fe7a4a6a",
    kind: "news cards with photo thumbnails in clipping frames",
  },
  {
    id: "hospitality",
    exportId: "af5f6ecb-e9a4-4e88-a5cc-6781d7daccb6",
    kind: "a photo that runs past the block clipping it, over a row of fixture cards",
  },
  {
    id: "team-page",
    exportId: "efd5e040-05ca-4d64-81ea-34802a6d4954",
    kind: "a whole page: a carousel, a squad strip and masked art over a textured background",
  },
  {
    id: "match-centre",
    exportId: "5b58247f-fc20-4266-a88a-12829e5a8161",
    kind: "a live scoreboard on a gradient with rotated images, a mask group and cover-fit player photos",
  },
] as const;
