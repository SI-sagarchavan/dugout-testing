// pnpm token <tenant> [subject] — a local dev token for the API.
import { userInfo } from "node:os";
import { loadEnv, loadTenants } from "@dugout/core";
import { issueToken, LOCAL_DEV_SECRET } from "../src/index.ts";

loadEnv();
const [tenant, subject = userInfo().username] = process.argv.slice(2);
if (!tenant) {
  console.error("usage: pnpm token <tenant> [subject]");
  process.exit(2);
}
loadTenants().require(tenant);
console.log(
  await issueToken({
    secret: process.env.DUGOUT_JWT_SECRET || LOCAL_DEV_SECRET,
    subject,
    tenantId: tenant,
  }),
);
