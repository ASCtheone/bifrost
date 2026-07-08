// ── Shared Types ─────────────────────────────────────────────────

export type NodeStatus = "online" | "offline";
export type NodeRole = "primary" | "secondary";
export type SyncState = "synced" | "applying" | "error" | "drift";
export type AdoptionStatus = "pending" | "available" | "adopted" | "revoked";

export type AuditAction =
  | "node.registered"
  | "node.removed"
  | "node.promoted"
  | "node.demoted"
  | "node.auto_promoted"
  | "node.created"
  | "node.adopted"
  | "node.key_revoked"
  | "config.updated"
  | "config.force_resync"
  | "peer.created"
  | "peer.updated"
  | "peer.deleted";

// ── Base DynamoDB Item ───────────────────────────────────────────

export interface DynamoItem {
  readonly PK: string;
  readonly SK: string;
  readonly GSI1PK?: string;
  readonly GSI1SK?: string;
  readonly GSI2PK?: string;
  readonly GSI2SK?: string;
  readonly GSI3PK?: string;
  readonly GSI3SK?: string;
}

// ── Node ─────────────────────────────────────────────────────────

export interface VpnConfigSnapshot {
  readonly servers: readonly ServerSnapshot[];
  readonly peers: readonly PeerSnapshot[];
}

export interface ServerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly publicKey: string;
}

export interface PeerSnapshot {
  readonly id: string;
  readonly name: string;
  readonly ip: string;
  readonly publicKey: string;
  readonly enabled: boolean;
}

export interface NodeEntity extends DynamoItem {
  readonly entityType: "Node";
  readonly nodeId: string;
  readonly nodeName: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly status: NodeStatus;
  readonly role: NodeRole;
  readonly priority: number;
  readonly lastSeen: string; // ISO 8601
  readonly tunnelUrl: string;
  readonly tunnelId: string;
  readonly controllerUrl: string;
  readonly controllerApiKey: string | null;
  readonly sparkVpnName: string | null;
  readonly sparkVpnId: string | null;
  readonly pendingVpnCreate: boolean;
  readonly syncState: SyncState;
  readonly lastAppliedVersion: number;
  readonly actualConfig: VpnConfigSnapshot | null;
  readonly error: string | null;
  readonly adoptionStatus: AdoptionStatus;
  readonly adoptionCode: string | null;
  readonly codeExpiresAt: string | null;
  readonly nodeKeyHash: string | null;
  readonly keyIssuedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Pending Key (temporary, for adoption handoff) ───────────────

export interface PendingKeyEntity extends DynamoItem {
  readonly entityType: "PendingKey";
  readonly nodeId: string;
  readonly rawKey: string;
  readonly ttl: number; // DynamoDB TTL epoch seconds
}

// ── Device (VPN client) ─────────────────────────────────────────

export type DeviceType = "router" | "phone" | "tablet" | "laptop";
export type ProvisionMethod = "qrcode" | "url" | "redirect" | "headless";
export type DeviceStatus = "pending" | "provisioned" | "active" | "revoked";

export interface DeviceEntity extends DynamoItem {
  readonly entityType: "Device";
  readonly deviceId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly status: DeviceStatus;
  readonly provisionMethod: ProvisionMethod;
  readonly provisionToken: string | null;
  readonly assignedIp: string;
  readonly publicKey: string;
  readonly privateKey: string;
  readonly presharedKey: string;
  readonly serverPublicKey: string;
  readonly serverEndpoint: string;
  readonly serverPort: number;
  readonly dns: readonly string[];
  readonly allowedIps: readonly string[];
  readonly unifiPeerId: string | null;
  readonly enabled: boolean;
  readonly lastSeen: string | null;
  readonly createdBy: string;
  readonly ownerEmail: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Peer ─────────────────────────────────────────────────────────

export interface PeerEntity extends DynamoItem {
  readonly entityType: "Peer";
  readonly peerId: string;
  readonly name: string;
  readonly serverId: string;
  readonly nodeId: string;
  readonly unifiPeerId: string;
  readonly publicKey: string;
  readonly privateKeyEncrypted: string;
  readonly presharedKey?: string;
  readonly assignedIp: string;
  readonly allowedIps: readonly string[];
  readonly endpoint: string;
  readonly configVersion: number;
  readonly enabled: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePeerInput {
  readonly name: string;
  readonly serverId: string;
  readonly nodeId: string;
  readonly allowedIps?: readonly string[];
}

export interface UpdatePeerInput {
  readonly name?: string;
  readonly allowedIps?: readonly string[];
  readonly enabled?: boolean;
}

// ── VPN Config ───────────────────────────────────────────────────

export interface VpnServerConfig {
  readonly listenPort: number;
  readonly address: string;
  readonly dns: readonly string[];
  readonly mtu: number;
  readonly hostAddress: string;
}

export interface VpnPeerDefaults {
  readonly allowedIps: readonly string[];
  readonly persistentKeepalive: number;
}

export interface VpnConfigEntity extends DynamoItem {
  readonly entityType: "VpnConfig";
  readonly configVersion: number;
  readonly server: VpnServerConfig;
  readonly defaults: VpnPeerDefaults;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

// ── IP Pool ──────────────────────────────────────────────────────

export interface IpPoolEntity extends DynamoItem {
  readonly entityType: "IpPool";
  readonly subnetKey: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly allocated: Readonly<Record<string, string>>;
  readonly nextAvailable: number;
  readonly totalAddresses: number;
}

// ── System Config ────────────────────────────────────────────────

export interface SystemConfigEntity extends DynamoItem {
  readonly entityType: "SystemConfig";
  readonly heartbeatIntervalSeconds: number;
  readonly staleThresholdSeconds: number;
  readonly syncTimeoutSeconds: number;
  readonly maxRetries: number;
  readonly driftCheckIntervalSeconds: number;
  readonly autoPromoteEnabled: boolean;
  readonly autoPromoteStaleSeconds: number;
}

export const DEFAULT_SYSTEM_CONFIG: Omit<SystemConfigEntity, keyof DynamoItem | "entityType"> = {
  heartbeatIntervalSeconds: 30,
  staleThresholdSeconds: 120,
  syncTimeoutSeconds: 60,
  maxRetries: 10,
  driftCheckIntervalSeconds: 300,
  autoPromoteEnabled: true,
  autoPromoteStaleSeconds: 120,
};

// ── Audit Log ────────────────────────────────────────────────────

export interface AuditLogEntity extends DynamoItem {
  readonly entityType: "AuditLog";
  readonly action: AuditAction;
  readonly actor: string;
  readonly targetId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
}

// ── WebSocket Connection ─────────────────────────────────────────

export interface WsConnectionEntity extends DynamoItem {
  readonly entityType: "WsConnection";
  readonly connectionId: string;
  readonly connectedAt: string;
  readonly ttl: number; // DynamoDB TTL epoch seconds
}
