import {
  UniFiClient,
  type UniFiConnectionConfig,
  type WgPeer,
  type WgServer,
  type CreateWgPeerRequest,
  type UpdateWgPeerRequest,
} from "@bifrost/unifi-connect";
import type {
  VpnConfigSnapshot,
  ServerSnapshot,
  PeerSnapshot,
} from "@bifrost/dynamo-schema";

export interface UniFiBridgeConfig {
  readonly connection: UniFiConnectionConfig;
}

export interface DiffResult {
  readonly toAdd: readonly CreateWgPeerRequest[];
  readonly toRemove: readonly string[];
  readonly toUpdate: readonly { readonly id: string; readonly changes: UpdateWgPeerRequest }[];
}

export class UniFiBridge {
  private readonly client: UniFiClient;

  constructor(config: UniFiBridgeConfig) {
    this.client = new UniFiClient(config.connection);
  }

  async readSnapshot(): Promise<VpnConfigSnapshot> {
    const servers = await this.client.servers.list();

    // Fetch peers per server — some firmware requires server-scoped queries
    let allPeers: WgPeer[] = [];
    try {
      const globalPeers = await this.client.peers.list();
      allPeers = [...globalPeers];
    } catch {
      // Fallback: fetch peers per server
      for (const server of servers) {
        try {
          const serverPeers = await this.client.peers.list(server._id);
          allPeers.push(...serverPeers);
        } catch (err) {
          console.warn(`[unifi-bridge] Failed to list peers for server ${server.name}:`, err);
        }
      }
    }

    return {
      servers: servers.map(mapServerToSnapshot),
      peers: allPeers.map(mapPeerToSnapshot),
    };
  }

  computeDiff(
    desiredPeers: readonly CreateWgPeerRequest[],
    actualPeers: readonly WgPeer[],
  ): DiffResult {
    const actualByName = new Map(actualPeers.map((p) => [p.name, p]));
    const desiredNames = new Set(desiredPeers.map((p) => p.name));

    const toAdd: CreateWgPeerRequest[] = [];
    const toUpdate: { readonly id: string; readonly changes: UpdateWgPeerRequest }[] = [];

    for (const desired of desiredPeers) {
      const actual = actualByName.get(desired.name);
      if (!actual) {
        toAdd.push(desired);
      } else {
        const changes = computePeerChanges(desired, actual);
        if (changes) {
          toUpdate.push({ id: actual._id, changes });
        }
      }
    }

    const toRemove = actualPeers
      .filter((p) => !desiredNames.has(p.name))
      .map((p) => p._id);

    return { toAdd, toRemove, toUpdate };
  }

  async diffAndApply(
    desiredPeers: readonly CreateWgPeerRequest[],
    serverId: string,
  ): Promise<VpnConfigSnapshot> {
    const actualPeers = await this.client.peers.list(serverId);
    const diff = this.computeDiff(desiredPeers, actualPeers);

    console.log(
      `[unifi-bridge] Diff: +${diff.toAdd.length} -${diff.toRemove.length} ~${diff.toUpdate.length}`,
    );

    // Execute removals first to free IPs
    for (const id of diff.toRemove) {
      await this.client.peers.delete(id);
      console.log(`[unifi-bridge] Removed peer ${id}`);
    }

    // Execute adds
    for (const req of diff.toAdd) {
      const created = await this.client.peers.create(req);
      console.log(`[unifi-bridge] Created peer ${created.name}`);
    }

    // Execute updates
    for (const { id, changes } of diff.toUpdate) {
      await this.client.peers.update(id, changes);
      console.log(`[unifi-bridge] Updated peer ${id}`);
    }

    // Read back confirmed state
    return this.readSnapshot();
  }

  async createWgServer(name: string): Promise<{ _id: string; name: string }> {
    return this.client.servers.createFromNetworkConf(name);
  }

  async getWanInfo(): Promise<{
    wanIp: string | null;
    ispName: string | null;
    speedDown: number | null;
    speedUp: number | null;
    speedPing: number | null;
  }> {
    let wanIp: string | null = null;
    let ispName: string | null = null;
    let speedDown: number | null = null;
    let speedUp: number | null = null;
    let speedPing: number | null = null;

    try {
      const health = await this.client.get<{
        subsystem: string;
        wan_ip?: string;
        isp_name?: string;
      }>("/stat/health");
      const wan = health.find((h) => h.subsystem === "wan");
      wanIp = wan?.wan_ip ?? null;
      ispName = wan?.isp_name ?? null;
    } catch { /* ignore */ }

    // Get speed test from v2 API
    try {
      const data = await this.client.rawRequest<{
        data?: readonly { download_mbps: number; upload_mbps: number; latency_ms: number; wan_networkgroup: string }[];
      }>("GET", "/proxy/network/v2/api/site/default/speedtest");
      const results = data.data ?? [];
      // Find latest non-zero WAN result
      const latest = [...results].reverse().find((r) => r.wan_networkgroup === "WAN" && r.download_mbps > 0);
      if (latest) {
        speedDown = latest.download_mbps;
        speedUp = latest.upload_mbps;
        speedPing = latest.latency_ms;
      }
    } catch { /* ignore */ }

    return { wanIp, ispName, speedDown, speedUp, speedPing };
  }

  async findPeerByName(name: string): Promise<WgPeer | null> {
    const peers = await this.client.peers.list();
    return peers.find((p) => p.name === name) ?? null;
  }

  async createPeer(request: CreateWgPeerRequest): Promise<WgPeer> {
    return this.client.peers.create(request);
  }

  async updatePeer(unifiPeerId: string, changes: UpdateWgPeerRequest): Promise<WgPeer> {
    return this.client.peers.update(unifiPeerId, changes);
  }

  async deletePeer(unifiPeerId: string): Promise<void> {
    await this.client.peers.delete(unifiPeerId);
  }

  async getServer(serverId: string): Promise<WgServer> {
    return this.client.servers.get(serverId);
  }

  async getPeer(unifiPeerId: string): Promise<WgPeer> {
    return this.client.peers.get(unifiPeerId);
  }

  async shutdown(): Promise<void> {
    await this.client.logout();
  }
}

function mapServerToSnapshot(server: WgServer): ServerSnapshot {
  return {
    id: server._id,
    name: server.name,
    serverAddress: server.server_address,
    serverPort: server.server_port,
    publicKey: server.server_public_key,
  };
}

function mapPeerToSnapshot(peer: WgPeer): PeerSnapshot {
  return {
    id: peer._id,
    name: peer.name,
    ip: peer.ip,
    publicKey: peer.public_key,
    enabled: peer.enabled,
  };
}

function computePeerChanges(
  desired: CreateWgPeerRequest,
  actual: WgPeer,
): UpdateWgPeerRequest | null {
  const changes: Record<string, unknown> = {};

  if (desired.enabled !== undefined && desired.enabled !== actual.enabled) {
    changes["enabled"] = desired.enabled;
  }
  if (desired.ip !== undefined && desired.ip !== actual.ip) {
    changes["ip"] = desired.ip;
  }
  if (desired.allowed_ips !== undefined) {
    const desiredSorted = [...desired.allowed_ips].sort();
    const actualSorted = [...actual.allowed_ips].sort();
    if (JSON.stringify(desiredSorted) !== JSON.stringify(actualSorted)) {
      changes["allowed_ips"] = desired.allowed_ips;
    }
  }

  return Object.keys(changes).length > 0 ? (changes as UpdateWgPeerRequest) : null;
}
