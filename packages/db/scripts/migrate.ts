import { loadEnv } from "../../core/src/tenants.ts";
import { adminDatabaseUrl, migrate } from "../src/index.ts";

loadEnv();
const applied = await migrate(adminDatabaseUrl());
console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
