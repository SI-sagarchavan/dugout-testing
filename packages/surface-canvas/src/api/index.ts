export { describeError } from "./describe-error.js";
export {
  API_TIMEOUT_MS,
  createApiClient,
  EVENTS_PATH,
  type ApiClient,
} from "./client.js";
export {
  createHandoffsClient,
  runHandoff,
  HANDOFFS_PATH,
  UPLOAD_CONCURRENCY,
  type Failure,
  type HandoffOutcome,
  type HandoffSource,
  type HandoffsClient,
  type Step,
  type Upload,
} from "./handoffs-client.js";
export {
  manifestOf,
  prepareHandoff,
  sniffImageType,
  UnsupportedAssetError,
  type ManifestFile,
  type PreparedFile,
  type PreparedHandoff,
  type HandoffFileKind,
  type HandoffInput,
} from "./uploads.js";
export {
  API_ORIGINS,
  AUTH_BASE_URLS,
  DEFAULT_API_ORIGIN,
  DEFAULT_AUTH_BASE_URL,
  isAllowedLoginUrl,
  LOGIN_ORIGINS,
  normalizeOrigin,
  resolveAuthBaseUrl,
  resolveOrigin,
  type ApiOrigin,
} from "./origin.js";
export type {
  ApiFetch,
  ApiFetchInit,
  ApiFetchResponse,
  ApiResult,
  StudioEvent,
  StudioPage,
} from "./types.js";
