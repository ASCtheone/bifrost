export { getDocClient, getTableName } from "./client.js";

export {
  getNode,
  putNode,
  putNodeIfNotExists,
  deleteNode,
  updateNodeRole,
  queryNodesByRole,
  queryOnlineSecondariesByPriority,
  queryAllNodes,
  getNodeByAdoptionCode,
  updateAdoptionStatus,
  setNodeKeyHash,
  revokeNodeKey,
  putPendingKey,
  getPendingKey,
  deletePendingKey,
} from "./node-repo.js";

export {
  getPeer,
  putPeer,
  deletePeer,
  updatePeer,
  queryPeersByServer,
} from "./peer-repo.js";

export {
  getVpnConfig,
  updateVpnConfig,
  incrementConfigVersion,
  type UpdateVpnConfigParams,
} from "./config-repo.js";

export {
  getIpPool,
  createIpPool,
  allocateIp,
  releaseIp,
} from "./ip-pool-repo.js";

export { writeAuditLog } from "./audit-repo.js";

export { getSystemConfig, type SystemConfig } from "./system-config-repo.js";

export {
  getDevice,
  putDevice,
  deleteDevice,
  queryDevicesByNode,
  queryAllDevices,
  getDeviceByToken,
  updateDeviceStatus,
  updateDeviceUnifiPeerId,
} from "./device-repo.js";

export {
  putConnection,
  deleteConnection,
  getAllConnections,
} from "./ws-connection-repo.js";
