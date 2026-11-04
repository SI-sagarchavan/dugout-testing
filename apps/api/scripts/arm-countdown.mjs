// Sets the first upcoming match of the fixtures strip sample to start N seconds from now
// (default 75), so a countdown can be watched reaching zero. Usage:
//   node apps/api/scripts/arm-countdown.mjs [seconds]
// Then reload the preview with &data=fixtures-strip. The file is read on each request.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../data/fixtures-strip.json", import.meta.url));
const seconds = Number(process.argv[2] ?? 75);
const data = JSON.parse(readFileSync(file, "utf8"));
const match = data.fixtures.castFlow.data["1"]
  .flatMap((day) => day.matches)
  .find((m) => m.state === "upcoming");
const at = new Date(Date.now() + seconds * 1000);
match.start_time = at.toISOString().replace(/\.\d{3}Z$/, "+00:00");
writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log(`${match.match_id} starts ${match.start_time} (in ${seconds}s)`);
