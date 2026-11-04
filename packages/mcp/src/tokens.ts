import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** One tenant's grant to an MCP server. The tenant id is the key; the model never supplies it. */
export interface Grant {
  /** The site the grant was approved for; Cast's entry sends it as the `client` header. */
  site: string;
  /** Where the grant is refreshed; `<server url>/oauth/token` for grants saved before this. */
  tokenEndpoint?: string;
  clientId: string;
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
}

export type GrantFile = Record<string, Grant>;

export interface TokenStore {
  read(tenantId: string): Promise<Grant | undefined>;
  write(tenantId: string, grant: Grant): Promise<void>;
}

/**
 * Grants in one JSON file (mode 0600). Refresh tokens rotate and a reused one revokes the grant,
 * so every rotation is written before the new access token is used.
 */
export function fileTokenStore(path: string): TokenStore {
  const load = async (): Promise<GrantFile> => {
    try {
      return JSON.parse(await readFile(path, "utf8")) as GrantFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: async (tenantId) => (await load())[tenantId],
    write: (tenantId, grant) => {
      const next = queue.then(async () => {
        const all = await load();
        all[tenantId] = grant;
        await mkdir(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      });
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
