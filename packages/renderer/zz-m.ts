import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1400, height: 300 } });
await p.setContent(readFileSync(process.argv[2], "utf8"));
for (const id of ["stack_2", "stack_3", "button", "button_2", "videos", "videos_2", "box"]) {
  console.log(id, await p.locator(`[data-fos-id="${id}"]`).first().evaluate((e) => { const r = e.getBoundingClientRect(); const c = getComputedStyle(e); return `x=${Math.round(r.x)} w=${Math.round(r.width)} flex=${c.flex} minW=${c.minWidth} pos=${c.position} bg=${c.backgroundColor}`; }));
}
await p.screenshot({ path: process.argv[3], clip: { x: 0, y: 0, width: 800, height: 80 } });
await b.close();
