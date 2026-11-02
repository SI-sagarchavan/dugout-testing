import { join, resolve } from "node:path";
import { McpClient } from "./client.ts";
import { fileTokenStore } from "./tokens.ts";

export { CAST_TOOLS, castTools } from "./cast.ts";
export { McpClient, type McpClientOptions, McpError } from "./client.ts";
export { fileTokenStore, type Grant, type TokenStore } from "./tokens.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Where grants are kept: `CAST_MCP_TOKENS`, else `.runs/cast-mcp.json` at the repo root, whatever the cwd. */
export function castTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CAST_MCP_TOKENS?.trim() || join(REPO_ROOT, ".runs", "cast-mcp.json");
}

/** The Cast client from the environment: `CAST_MCP_URL`, and grants in `CAST_MCP_TOKENS`. */
export function castClientFromEnv(env: NodeJS.ProcessEnv = process.env): McpClient {
  const url = env.CAST_MCP_URL?.trim();
  if (!url) throw new Error("CAST_MCP_URL is not set");
  return new McpClient({ url, tokens: fileTokenStore(castTokenPath(env)) });
}
