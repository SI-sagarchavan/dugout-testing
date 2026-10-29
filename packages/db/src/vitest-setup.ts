import { prepareDatabase } from "./testing.ts";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    adminDatabaseUrl: string;
  }
}

/** vitest globalSetup: tests read the URLs with `inject("databaseUrl")`. */
export default async function setup({
  provide,
}: {
  provide: (key: string, value: string) => void;
}) {
  const { appUrl, adminUrl } = await prepareDatabase();
  provide("databaseUrl", appUrl);
  provide("adminDatabaseUrl", adminUrl);
}
