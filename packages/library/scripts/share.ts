// pnpm agent library share --tenant demo-cricket [--on | --off]
// Whether the tenant's previewed sections are in the shared pool other tenants search (their
// skeletons, never their pictures). Every tenant shares unless it is turned off. With neither
// flag, says which it is.
import { parseArgs } from "node:util";
import { loadEnv, loadTenants } from "@dugout/core";
import { openLibrary } from "./common.ts";

loadEnv();
const { values } = parseArgs({
  options: { tenant: { type: "string" }, on: { type: "boolean" }, off: { type: "boolean" } },
});
if (!values.tenant || (values.on && values.off)) {
  console.error("usage: pnpm agent library share --tenant <id> [--on | --off]");
  process.exit(2);
}
const tenant = loadTenants().require(values.tenant);
const { pool, library } = openLibrary();
if (values.on || values.off) await library.setSharing(tenant.id, Boolean(values.on));
const shares = await library.sharing(tenant.id);
console.log(
  shares
    ? `${tenant.id} shares: other tenants see the skeletons of its previewed sections`
    : `${tenant.id} does not share: only it sees its sections`,
);
await pool.end();
