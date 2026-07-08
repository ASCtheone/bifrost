// ── Primary Key Builders ──────────────────────────────────────────

export const nodeKey = (nodeId: string) => ({
  PK: `NODE#${nodeId}`,
  SK: `NODE#${nodeId}`,
});

export const deviceKey = (deviceId: string) => ({
  PK: `DEVICE#${deviceId}`,
  SK: `DEVICE#${deviceId}`,
});

export const deviceNodeGsi1 = (nodeId: string, deviceId: string) => ({
  GSI1PK: `DEVICE_NODE#${nodeId}`,
  GSI1SK: `${deviceId}`,
});

export const deviceTokenGsi3 = (token: string) => ({
  GSI3PK: `PROVISION#${token}`,
  GSI3SK: `PROVISION#${token}`,
});

export const extractDeviceId = (pk: string): string => pk.replace("DEVICE#", "");

export const peerKey = (peerId: string) => ({
  PK: `PEER#${peerId}`,
  SK: `PEER#${peerId}`,
});

export const vpnConfigKey = () => ({
  PK: "CONFIG#vpn",
  SK: "CONFIG#vpn",
});

export const ipPoolKey = (subnetKey: string) => ({
  PK: `IPPOOL#${subnetKey}`,
  SK: `IPPOOL#${subnetKey}`,
});

export const systemConfigKey = () => ({
  PK: "CONFIG#system",
  SK: "CONFIG#system",
});

export const auditKey = (yearMonth: string) => ({
  PK: `AUDIT#${yearMonth}`,
});

export const auditSortKey = (timestamp: string, ulid: string) => ({
  SK: `${timestamp}#${ulid}`,
});

export const wsConnectionKey = (connectionId: string) => ({
  PK: `WSCONN#${connectionId}`,
  SK: `WSCONN#${connectionId}`,
});

// ── GSI1 Key Builders ────────────────────────────────────────────

export const nodeRoleGsi1 = (role: string, priority: number, nodeId: string) => ({
  GSI1PK: `NODE_ROLE#${role}`,
  GSI1SK: `${String(priority).padStart(5, "0")}#${nodeId}`,
});

export const peerServerGsi1 = (serverId: string, enabled: boolean, peerId: string) => ({
  GSI1PK: `PEER_SERVER#${serverId}`,
  GSI1SK: `${enabled ? "1" : "0"}#${peerId}`,
});

// ── GSI3 Key Builders ────────────────────────────────────────────

export const nodeAdoptionCodeGsi3 = (adoptionCode: string) => ({
  GSI3PK: `ADOPTION#${adoptionCode}`,
  GSI3SK: `ADOPTION#${adoptionCode}`,
});

// ── Pending Key ─────────────────────────────────────────────────

export const pendingKeyKey = (nodeId: string) => ({
  PK: `PENDING_KEY#${nodeId}`,
  SK: `PENDING_KEY#${nodeId}`,
});

// ── GSI2 Key Builders ────────────────────────────────────────────

export const nodeStatusGsi2 = (status: string, lastSeen: string, nodeId: string) => ({
  GSI2PK: `NODE_STATUS#${status}`,
  GSI2SK: `${lastSeen}#${nodeId}`,
});

// ── Key Extractors ───────────────────────────────────────────────

export const extractNodeId = (pk: string): string => pk.replace("NODE#", "");
export const extractPeerId = (pk: string): string => pk.replace("PEER#", "");
export const extractConnectionId = (pk: string): string => pk.replace("WSCONN#", "");
export const extractSubnetKey = (pk: string): string => pk.replace("IPPOOL#", "");
