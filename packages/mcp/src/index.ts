/**
 * MCP servers as configured tool sources (ADR 0026). Agents ask for capabilities; the registry
 * (`config/mcp/<server>.json`) says which servers have them and how each tool is treated; the lock
 * (`<server>.lock.json`) pins what the model reads; the hub connects through the official MCP SDK,
 * adding each tenant's credentials.
 */
export type { ServerAdapter, ServerCall } from "./adapter.ts";
export {
  describeHook,
  type HookData,
  hookOutput,
  NotSampled,
  unsafeToRun,
} from "./adapters/cast.ts";
export { type AuthOptions, authFetch, McpAuthError } from "./auth.ts";
export {
  ADAPTERS,
  type CapabilityRequest,
  createMcpHost,
  defaultMcpHost,
  type HostOptions,
  type McpHost,
  type Resolution,
  type SyncReport,
  syncServer,
} from "./host.ts";
export {
  createMcpHub,
  type HubOptions,
  type McpHub,
  McpUnavailable,
  resultOf,
  type ServerInfo,
  type ToolResult,
} from "./hub.ts";
export {
  drift,
  Lock,
  LockedResource,
  LockedTool,
  lockPath,
  type RemoteResource,
  type RemoteTool,
  readLock,
  resourceHash,
  sha256,
  toolHash,
  writeLock,
} from "./lock.ts";
export {
  type Capability,
  checkEntry,
  type Grant as ToolGrant,
  loadRegistry,
  pathOf,
  REGISTRY_DIR,
  type Registry,
  readValue,
  resourceToolName,
  ServerEntry,
  type ToolPolicy,
  toolName,
} from "./registry.ts";
export { inlineRefs, zodOf } from "./schema.ts";
export { fileTokenStore, type Grant, type TokenStore } from "./tokens.ts";
export {
  McpConfigError,
  outsideGrants,
  pinnedArguments,
  type ServerToolsOptions,
  serverTools,
  withoutPinned,
} from "./tools.ts";
