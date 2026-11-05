export { describeError } from "./describe-error.js";
export {
  API_TIMEOUT_MS,
  createApiClient,
  EVENTS_PATH,
  type ApiClient,
} from "./client.js";
export {
  createSendsClient,
  runSend,
  SENDS_PATH,
  UPLOAD_CONCURRENCY,
  type Failure,
  type SendOutcome,
  type SendSource,
  type SendsClient,
  type Step,
  type Upload,
} from "./sends-client.js";
export {
  manifestOf,
  prepareSend,
  sniffImageType,
  UnsupportedAssetError,
  type ManifestFile,
  type PreparedFile,
  type PreparedSend,
  type SendFileKind,
  type SendInput,
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
