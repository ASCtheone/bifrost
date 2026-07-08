import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey, vpnConfigKey } from "@bifrost/dynamo-schema";
import { getDocClient } from "./aws-client.js";

export type SyncCallback = (
  desiredConfig: Record<string, unknown>,
  configVersion: number,
) => Promise<void>;

export class ConfigListener {
  private readonly nodeId: string;
  private readonly tableName: string;
  private readonly wsUrl: string;
  private lastAppliedVersion: number = 0;
  private onSync: SyncCallback | null = null;
  private ws: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(nodeId: string, tableName: string, wsUrl: string) {
    this.nodeId = nodeId;
    this.tableName = tableName;
    this.wsUrl = wsUrl;
  }

  async init(): Promise<void> {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: this.tableName,
        Key: nodeKey(this.nodeId),
      }),
    );

    if (result.Item) {
      this.lastAppliedVersion =
        (result.Item["lastAppliedVersion"] as number) ?? 0;
    }
  }

  setSyncCallback(callback: SyncCallback): void {
    this.onSync = callback;
  }

  start(): void {
    this.stopped = false;
    this.connectWebSocket();
    // Poll fallback every 30s in case WebSocket drops
    this.pollTimer = setInterval(() => {
      this.pollConfig().catch((err) =>
        console.error("[config-listener] poll failed:", err),
      );
    }, 30000);
  }

  stop(): void {
    this.stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private connectWebSocket(): void {
    try {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            changes?: readonly { keys?: Record<string, unknown> }[];
          };
          if (msg.type === "change") {
            // A DynamoDB change came through — check if it's vpn config
            const hasConfigChange = msg.changes?.some(
              (c) => {
                const pk = c.keys?.["PK"] as Record<string, string> | undefined;
                return pk?.["S"] === "CONFIG#vpn";
              },
            );
            if (hasConfigChange) {
              this.pollConfig().catch((err) =>
                console.error("[config-listener] ws-triggered poll failed:", err),
              );
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      this.ws.onclose = () => {
        if (!this.stopped) {
          console.log("[config-listener] WebSocket closed, reconnecting in 5s...");
          setTimeout(() => this.connectWebSocket(), 5000);
        }
      };

      this.ws.onerror = (err) => {
        console.error("[config-listener] WebSocket error:", err);
      };
    } catch {
      console.warn("[config-listener] WebSocket connect failed, relying on poll");
    }
  }

  private async pollConfig(): Promise<void> {
    const result = await getDocClient().send(
      new GetCommand({
        TableName: this.tableName,
        Key: vpnConfigKey(),
      }),
    );

    if (!result.Item) return;

    const configVersion = result.Item["configVersion"] as number;
    if (configVersion <= this.lastAppliedVersion) return;

    console.log(
      `[config-listener] New config version ${configVersion} (last applied: ${this.lastAppliedVersion})`,
    );

    await this.applyConfig(
      result.Item as Record<string, unknown>,
      configVersion,
    );
  }

  private async applyConfig(
    data: Record<string, unknown>,
    configVersion: number,
  ): Promise<void> {
    const now = new Date().toISOString();

    await getDocClient().send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: nodeKey(this.nodeId),
        UpdateExpression: "SET #syncState = :applying, #updatedAt = :now",
        ExpressionAttributeNames: {
          "#syncState": "syncState",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":applying": "applying",
          ":now": now,
        },
      }),
    );

    try {
      if (this.onSync) {
        await this.onSync(data, configVersion);
      }

      this.lastAppliedVersion = configVersion;

      await getDocClient().send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: nodeKey(this.nodeId),
          UpdateExpression:
            "SET #syncState = :synced, #lastAppliedVersion = :ver, #error = :null, #updatedAt = :now",
          ExpressionAttributeNames: {
            "#syncState": "syncState",
            "#lastAppliedVersion": "lastAppliedVersion",
            "#error": "error",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":synced": "synced",
            ":ver": configVersion,
            ":null": null,
            ":now": new Date().toISOString(),
          },
        }),
      );

      console.log(`[config-listener] Applied config version ${configVersion}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);

      await getDocClient().send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: nodeKey(this.nodeId),
          UpdateExpression:
            "SET #syncState = :err, #error = :msg, #updatedAt = :now",
          ExpressionAttributeNames: {
            "#syncState": "syncState",
            "#error": "error",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":err": "error",
            ":msg": message,
            ":now": new Date().toISOString(),
          },
        }),
      );

      console.error(
        `[config-listener] Failed to apply config version ${configVersion}:`,
        message,
      );
    }
  }
}
