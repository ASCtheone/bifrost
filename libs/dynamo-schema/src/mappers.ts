import type {
  NodeEntity,
  DeviceEntity,
  DeviceType,
  DeviceStatus,
  ProvisionMethod,
  PeerEntity,
  VpnConfigEntity,
  IpPoolEntity,
  SystemConfigEntity,
  AuditLogEntity,
  WsConnectionEntity,
  PendingKeyEntity,
  NodeStatus,
  NodeRole,
  SyncState,
  AdoptionStatus,
  VpnConfigSnapshot,
  VpnServerConfig,
  VpnPeerDefaults,
  AuditAction,
} from "./entities.js";

import {
  nodeKey,
  nodeRoleGsi1,
  nodeStatusGsi2,
  nodeAdoptionCodeGsi3,
  pendingKeyKey,
  deviceKey,
  deviceNodeGsi1,
  deviceTokenGsi3,
  peerKey,
  peerServerGsi1,
  vpnConfigKey,
  ipPoolKey,
  systemConfigKey,
  auditKey,
  auditSortKey,
  wsConnectionKey,
} from "./keys.js";

// ── Node ─────────────────────────────────────────────────────────

export interface NodeInput {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly ownerId: string;
  readonly ownerEmail: string;
  readonly status: NodeStatus;
  readonly role: NodeRole;
  readonly priority: number;
  readonly lastSeen: string;
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

export const toNodeItem = (input: NodeInput): NodeEntity => ({
  ...nodeKey(input.nodeId),
  ...nodeRoleGsi1(input.role, input.priority, input.nodeId),
  ...nodeStatusGsi2(input.status, input.lastSeen, input.nodeId),
  ...(input.adoptionCode ? nodeAdoptionCodeGsi3(input.adoptionCode) : {}),
  entityType: "Node",
  ...input,
});

// ── Pending Key ─────────────────────────────────────────────────

export interface PendingKeyInput {
  readonly nodeId: string;
  readonly rawKey: string;
  readonly ttlSeconds: number;
}

export const toPendingKeyItem = (input: PendingKeyInput): PendingKeyEntity => ({
  ...pendingKeyKey(input.nodeId),
  entityType: "PendingKey",
  nodeId: input.nodeId,
  rawKey: input.rawKey,
  ttl: Math.floor(Date.now() / 1000) + input.ttlSeconds,
});

export const fromPendingKeyItem = (item: Record<string, unknown>): PendingKeyEntity =>
  item as unknown as PendingKeyEntity;

export const fromNodeItem = (item: Record<string, unknown>): NodeEntity =>
  item as unknown as NodeEntity;

// ── Device ──────────────────────────────────────────────────────

export interface DeviceInput {
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

export const toDeviceItem = (input: DeviceInput): DeviceEntity => ({
  ...deviceKey(input.deviceId),
  ...deviceNodeGsi1(input.nodeId, input.deviceId),
  ...(input.provisionToken ? deviceTokenGsi3(input.provisionToken) : {}),
  entityType: "Device",
  ...input,
});

export const fromDeviceItem = (item: Record<string, unknown>): DeviceEntity =>
  item as unknown as DeviceEntity;

// ── Peer ─────────────────────────────────────────────────────────

export interface PeerInput {
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

export const toPeerItem = (input: PeerInput): PeerEntity => ({
  ...peerKey(input.peerId),
  ...peerServerGsi1(input.serverId, input.enabled, input.peerId),
  entityType: "Peer",
  ...input,
});

export const fromPeerItem = (item: Record<string, unknown>): PeerEntity =>
  item as unknown as PeerEntity;

// ── VPN Config ───────────────────────────────────────────────────

export interface VpnConfigInput {
  readonly configVersion: number;
  readonly server: VpnServerConfig;
  readonly defaults: VpnPeerDefaults;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export const toVpnConfigItem = (input: VpnConfigInput): VpnConfigEntity => ({
  ...vpnConfigKey(),
  entityType: "VpnConfig",
  ...input,
});

export const fromVpnConfigItem = (item: Record<string, unknown>): VpnConfigEntity =>
  item as unknown as VpnConfigEntity;

// ── IP Pool ──────────────────────────────────────────────────────

export interface IpPoolInput {
  readonly subnetKey: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly allocated: Readonly<Record<string, string>>;
  readonly nextAvailable: number;
  readonly totalAddresses: number;
}

export const toIpPoolItem = (input: IpPoolInput): IpPoolEntity => ({
  ...ipPoolKey(input.subnetKey),
  entityType: "IpPool",
  ...input,
});

export const fromIpPoolItem = (item: Record<string, unknown>): IpPoolEntity =>
  item as unknown as IpPoolEntity;

// ── System Config ────────────────────────────────────────────────

export interface SystemConfigInput {
  readonly heartbeatIntervalSeconds: number;
  readonly staleThresholdSeconds: number;
  readonly syncTimeoutSeconds: number;
  readonly maxRetries: number;
  readonly driftCheckIntervalSeconds: number;
  readonly autoPromoteEnabled: boolean;
  readonly autoPromoteStaleSeconds: number;
}

export const toSystemConfigItem = (input: SystemConfigInput): SystemConfigEntity => ({
  ...systemConfigKey(),
  entityType: "SystemConfig",
  ...input,
});

export const fromSystemConfigItem = (item: Record<string, unknown>): SystemConfigEntity =>
  item as unknown as SystemConfigEntity;

// ── Audit Log ────────────────────────────────────────────────────

export interface AuditLogInput {
  readonly action: AuditAction;
  readonly actor: string;
  readonly targetId: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly timestamp: string;
  readonly ulid: string;
}

export const toAuditLogItem = (input: AuditLogInput): AuditLogEntity => {
  const yearMonth = input.timestamp.slice(0, 7); // "YYYY-MM"
  return {
    ...auditKey(yearMonth),
    ...auditSortKey(input.timestamp, input.ulid),
    entityType: "AuditLog",
    action: input.action,
    actor: input.actor,
    targetId: input.targetId,
    details: input.details,
    timestamp: input.timestamp,
  };
};

export const fromAuditLogItem = (item: Record<string, unknown>): AuditLogEntity =>
  item as unknown as AuditLogEntity;

// ── WebSocket Connection ─────────────────────────────────────────

export interface WsConnectionInput {
  readonly connectionId: string;
  readonly connectedAt: string;
  readonly ttlSeconds: number;
}

export const toWsConnectionItem = (input: WsConnectionInput): WsConnectionEntity => ({
  ...wsConnectionKey(input.connectionId),
  entityType: "WsConnection",
  connectionId: input.connectionId,
  connectedAt: input.connectedAt,
  ttl: Math.floor(Date.now() / 1000) + input.ttlSeconds,
});

export const fromWsConnectionItem = (item: Record<string, unknown>): WsConnectionEntity =>
  item as unknown as WsConnectionEntity;
