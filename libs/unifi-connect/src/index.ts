export { UniFiClient } from "./client.js";
export { generatePeerConfig } from "./config-gen.js";
export {
  UniFiApiError,
  AuthError,
  NetworkError,
  NotFoundError,
} from "./errors.js";
export type {
  UniFiConnectionConfig,
  SessionState,
  UniFiMeta,
  UniFiResponse,
  WgServer,
  WgPeer,
  CreateWgPeerRequest,
  UpdateWgPeerRequest,
} from "./types/index.js";
