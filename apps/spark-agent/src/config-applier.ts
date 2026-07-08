import { GetCommand, UpdateCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey } from "@bifrost/dynamo-schema";
import type { VpnConfigSnapshot, PeerSnapshot } from "@bifrost/dynamo-schema";
import type { UniFiBridge } from "./unifi-bridge.js";
import type { CreateWgPeerRequest } from "@bifrost/unifi-connect";
import { getDocClient } from "./aws-client.js";

export interface ConfigApplierOptions {
  readonly nodeId: string;
  readonly tableName: string;
  readonly bridge: UniFiBridge;
  readonly maxRetries: number;
  readonly baseRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
}

export class ConfigApplier {
  private readonly opts: ConfigApplierOptions;

  constructor(opts: ConfigApplierOptions) {
    this.opts = opts;
  }

  async apply(
    _desiredConfig: Record<string, unknown>,
    configVersion: number,
  ): Promise<void> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      try {
        const snapshot = await this.opts.bridge.readSnapshot();
        const server = snapshot.servers[0];
        if (!server) {
          throw new Error("No WireGuard server found on UniFi controller");
        }

        const desiredPeers = await this.readDesiredPeers(server.id);
        const actualConfig = await this.opts.bridge.diffAndApply(
          desiredPeers,
          server.id,
        );

        const now = new Date().toISOString();
        await getDocClient().send(
          new UpdateCommand({
            TableName: this.opts.tableName,
            Key: nodeKey(this.opts.nodeId),
            UpdateExpression:
              "SET #actualConfig = :config, #lastAppliedVersion = :ver, #syncState = :synced, #error = :null, #updatedAt = :now",
            ExpressionAttributeNames: {
              "#actualConfig": "actualConfig",
              "#lastAppliedVersion": "lastAppliedVersion",
              "#syncState": "syncState",
              "#error": "error",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":config": actualConfig,
              ":ver": configVersion,
              ":synced": "synced",
              ":null": null,
              ":now": now,
            },
          }),
        );

        console.log(
          `[config-applier] Config v${configVersion} applied successfully`,
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt < this.opts.maxRetries) {
          const delay = Math.min(
            this.opts.baseRetryDelayMs * Math.pow(2, attempt),
            this.opts.maxRetryDelayMs,
          );
          console.warn(
            `[config-applier] Attempt ${attempt + 1} failed, retrying in ${delay}ms: ${lastError.message}`,
          );
          await sleep(delay);
        }
      }
    }

    // All retries exhausted
    const now = new Date().toISOString();
    await getDocClient().send(
      new UpdateCommand({
        TableName: this.opts.tableName,
        Key: nodeKey(this.opts.nodeId),
        UpdateExpression:
          "SET #syncState = :err, #error = :msg, #updatedAt = :now",
        ExpressionAttributeNames: {
          "#syncState": "syncState",
          "#error": "error",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":err": "error",
          ":msg": lastError?.message ?? "Unknown error",
          ":now": now,
        },
      }),
    );

    throw lastError;
  }

  async readActualConfig(): Promise<VpnConfigSnapshot> {
    return this.opts.bridge.readSnapshot();
  }

  async checkDrift(): Promise<boolean> {
    try {
      const result = await getDocClient().send(
        new GetCommand({
          TableName: this.opts.tableName,
          Key: nodeKey(this.opts.nodeId),
        }),
      );

      const storedConfig = result.Item?.["actualConfig"] as VpnConfigSnapshot | null;
      if (!storedConfig) return false;

      const liveConfig = await this.opts.bridge.readSnapshot();
      const hasDrift = !snapshotsMatch(storedConfig, liveConfig);

      if (hasDrift) {
        console.warn("[config-applier] Drift detected between stored and live UniFi state");
        const now = new Date().toISOString();
        await getDocClient().send(
          new UpdateCommand({
            TableName: this.opts.tableName,
            Key: nodeKey(this.opts.nodeId),
            UpdateExpression:
              "SET #syncState = :drift, #updatedAt = :now",
            ExpressionAttributeNames: {
              "#syncState": "syncState",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":drift": "drift",
              ":now": now,
            },
          }),
        );
      }

      return hasDrift;
    } catch (error) {
      console.error("[config-applier] Drift check failed:", error);
      return false;
    }
  }

  private async readDesiredPeers(
    serverId: string,
  ): Promise<readonly CreateWgPeerRequest[]> {
    const result = await getDocClient().send(
      new QueryCommand({
        TableName: this.opts.tableName,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        FilterExpression: "#enabled = :true",
        ExpressionAttributeNames: { "#enabled": "enabled" },
        ExpressionAttributeValues: {
          ":pk": `PEER_SERVER#${serverId}`,
          ":true": true,
        },
      }),
    );

    return (result.Items ?? []).map((item) => ({
      name: item["name"] as string,
      server_id: serverId,
      ip: item["assignedIp"] as string,
      allowed_ips: [...(item["allowedIps"] as string[])],
      enabled: item["enabled"] as boolean,
    }));
  }
}

export class DriftDetector {
  private readonly applier: ConfigApplier;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(applier: ConfigApplier, intervalMs: number = 300000) {
    this.applier = applier;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      this.applier.checkDrift().catch((err) =>
        console.error("[drift] check failed:", err),
      );
    }, this.intervalMs);

    console.log(
      `[drift] Detector started (every ${this.intervalMs / 1000}s)`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function snapshotsMatch(
  a: VpnConfigSnapshot,
  b: VpnConfigSnapshot,
): boolean {
  if (a.peers.length !== b.peers.length) return false;
  if (a.servers.length !== b.servers.length) return false;

  const aPeers = new Map(a.peers.map((p) => [p.id, p]));
  for (const bp of b.peers) {
    const ap = aPeers.get(bp.id);
    if (!ap) return false;
    if (!peerSnapshotsMatch(ap, bp)) return false;
  }

  return true;
}

function peerSnapshotsMatch(a: PeerSnapshot, b: PeerSnapshot): boolean {
  return (
    a.name === b.name &&
    a.ip === b.ip &&
    a.publicKey === b.publicKey &&
    a.enabled === b.enabled
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
