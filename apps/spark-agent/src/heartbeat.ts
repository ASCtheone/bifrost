import type { UniFiBridge } from "./unifi-bridge.js";

interface PendingDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly publicKey: string;
  readonly presharedKey: string;
  readonly assignedIp: string;
}

interface NodeSelfResponse {
  readonly node?: {
    readonly sparkVpnName?: string | null;
    readonly sparkVpnId?: string | null;
    readonly pendingVpnCreate?: boolean;
    readonly pendingDevices?: readonly PendingDevice[];
    readonly pendingPeerDeletions?: readonly string[];
  };
}

export class Heartbeat {
  private readonly nodeId: string;
  private readonly intervalMs: number;
  private readonly apiUrl: string;
  private readonly nodeKey: string;
  private readonly bridge: UniFiBridge;
  private timer: ReturnType<typeof setInterval> | null = null;
  private vpnCreated = false;

  constructor(
    nodeId: string,
    intervalMs: number,
    apiUrl: string,
    nodeKey: string,
    bridge: UniFiBridge,
  ) {
    this.nodeId = nodeId;
    this.intervalMs = intervalMs;
    this.apiUrl = apiUrl;
    this.nodeKey = nodeKey;
    this.bridge = bridge;
  }

  async register(): Promise<void> {
    await this.sendHeartbeat();
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.beat().catch((err) =>
        console.error("[heartbeat] failed:", err),
      );
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
  }

  private async beat(): Promise<void> {
    await this.checkPendingCommands();
    await this.sendHeartbeat();
  }

  private async checkPendingCommands(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/nodes/${this.nodeId}/self`, {
        headers: { "X-Node-Key": this.nodeKey },
      });
      if (!res.ok) return;

      const data = await res.json() as NodeSelfResponse;
      const node = data.node;
      if (!node) return;

      // Handle pending VPN creation (only once)
      if (node.pendingVpnCreate && node.sparkVpnName && !node.sparkVpnId && !this.vpnCreated) {
        console.log(`[heartbeat] Creating VPN server: ${node.sparkVpnName}`);
        try {
          const created = await this.bridge.createWgServer(node.sparkVpnName);
          console.log(`[heartbeat] VPN server created: ${created._id}`);
          this.vpnCreated = true;

          // Report back to API
          await fetch(`${this.apiUrl}/nodes/${this.nodeId}/heartbeat`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Node-Key": this.nodeKey,
            },
            body: JSON.stringify({
              sparkVpnId: created._id,
              pendingVpnCreate: false,
            }),
          });
        } catch (err) {
          console.error("[heartbeat] Failed to create VPN server:", err);
        }
      }
      // Handle pending device peer creation
      if (node.pendingDevices?.length && node.sparkVpnId) {
        const createdPeers: { deviceId: string; unifiPeerId: string }[] = [];

        for (const device of node.pendingDevices) {
          const peerName = `bifrost-${device.name}`;
          console.log(`[heartbeat] Creating peer for device: ${device.name} (${device.deviceId})`);
          try {
            const peer = await this.bridge.createPeer({
              name: peerName,
              server_id: node.sparkVpnId,
              ip: device.assignedIp,
              public_key: device.publicKey,
              preshared_key: device.presharedKey,
              enabled: true,
            });
            console.log(`[heartbeat] Peer created: ${peer._id} for ${device.name}`);
            createdPeers.push({ deviceId: device.deviceId, unifiPeerId: peer._id });
          } catch (err: unknown) {
            const msg = (err as { apiMessage?: string }).apiMessage ?? "";
            // If duplicate name, find existing and use its ID
            if (msg.includes("DuplicateAccountName")) {
              console.log(`[heartbeat] Peer ${peerName} already exists, looking up...`);
              try {
                const existing = await this.bridge.findPeerByName(peerName);
                if (existing) {
                  console.log(`[heartbeat] Found existing peer: ${existing._id}`);
                  createdPeers.push({ deviceId: device.deviceId, unifiPeerId: existing._id });
                }
              } catch (lookupErr) {
                console.error(`[heartbeat] Failed to lookup peer ${peerName}:`, lookupErr);
              }
            } else {
              console.error(`[heartbeat] Failed to create peer for ${device.name}:`, err);
            }
          }
        }

        // Report created peers back
        if (createdPeers.length > 0) {
          await fetch(`${this.apiUrl}/nodes/${this.nodeId}/heartbeat`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              "X-Node-Key": this.nodeKey,
            },
            body: JSON.stringify({ createdPeers }),
          });
        }
      }
      // Handle pending peer deletions
      if (node.pendingPeerDeletions?.length) {
        for (const peerId of node.pendingPeerDeletions) {
          console.log(`[heartbeat] Deleting peer ${peerId} from controller`);
          try {
            await this.bridge.deletePeer(peerId);
            console.log(`[heartbeat] Peer ${peerId} deleted`);
          } catch (err) {
            console.error(`[heartbeat] Failed to delete peer ${peerId}:`, err);
          }
        }

        // Clear the pending list
        await fetch(`${this.apiUrl}/nodes/${this.nodeId}/heartbeat`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "X-Node-Key": this.nodeKey,
          },
          body: JSON.stringify({ clearPeerDeletions: true }),
        });
      }
    } catch {
      // Non-critical, continue with heartbeat
    }
  }

  private geoCache: { city?: string; country?: string; region?: string } | null = null;

  private async lookupGeo(ip: string): Promise<{ city: string; country: string; region: string } | null> {
    if (this.geoCache) return this.geoCache as { city: string; country: string; region: string };
    try {
      const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,country,regionName`);
      if (!res.ok) return null;
      const data = await res.json() as { city?: string; country?: string; regionName?: string };
      this.geoCache = { city: data.city, country: data.country, region: data.regionName };
      return this.geoCache as { city: string; country: string; region: string };
    } catch {
      return null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    let actualConfig = null;
    let wanIp: string | null = null;
    let geo: { city: string; country: string; region: string } | null = null;
    let ispName: string | null = null;
    let speedDown: number | null = null;
    let speedUp: number | null = null;
    let speedPing: number | null = null;
    try {
      actualConfig = await this.bridge.readSnapshot();
      const wanInfo = await this.bridge.getWanInfo();
      wanIp = wanInfo.wanIp;
      ispName = wanInfo.ispName;
      speedDown = wanInfo.speedDown;
      speedUp = wanInfo.speedUp;
      speedPing = wanInfo.speedPing;
      if (wanIp) geo = await this.lookupGeo(wanIp);
    } catch (err) {
      console.error("[heartbeat] Failed to read UniFi snapshot:", err);
    }

    const res = await fetch(`${this.apiUrl}/nodes/${this.nodeId}/heartbeat`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Node-Key": this.nodeKey,
      },
      body: JSON.stringify({ actualConfig, wanIp, geo, ispName, speedDown, speedUp, speedPing }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401) {
        console.error("[heartbeat] Node key rejected — may have been revoked");
        process.exit(1);
      }
      throw new Error(`Heartbeat failed: ${res.status} ${body}`);
    }
  }
}
