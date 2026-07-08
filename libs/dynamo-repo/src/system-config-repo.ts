import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  systemConfigKey,
  fromSystemConfigItem,
  DEFAULT_SYSTEM_CONFIG,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

export interface SystemConfig {
  readonly heartbeatIntervalSeconds: number;
  readonly staleThresholdSeconds: number;
  readonly syncTimeoutSeconds: number;
  readonly maxRetries: number;
  readonly driftCheckIntervalSeconds: number;
  readonly autoPromoteEnabled: boolean;
  readonly autoPromoteStaleSeconds: number;
}

export async function getSystemConfig(): Promise<SystemConfig> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: systemConfigKey(),
    }),
  );

  if (!result.Item) {
    return { ...DEFAULT_SYSTEM_CONFIG };
  }

  const item = fromSystemConfigItem(result.Item);
  return {
    heartbeatIntervalSeconds:
      item.heartbeatIntervalSeconds ?? DEFAULT_SYSTEM_CONFIG.heartbeatIntervalSeconds,
    staleThresholdSeconds:
      item.staleThresholdSeconds ?? DEFAULT_SYSTEM_CONFIG.staleThresholdSeconds,
    syncTimeoutSeconds:
      item.syncTimeoutSeconds ?? DEFAULT_SYSTEM_CONFIG.syncTimeoutSeconds,
    maxRetries: item.maxRetries ?? DEFAULT_SYSTEM_CONFIG.maxRetries,
    driftCheckIntervalSeconds:
      item.driftCheckIntervalSeconds ?? DEFAULT_SYSTEM_CONFIG.driftCheckIntervalSeconds,
    autoPromoteEnabled:
      item.autoPromoteEnabled ?? DEFAULT_SYSTEM_CONFIG.autoPromoteEnabled,
    autoPromoteStaleSeconds:
      item.autoPromoteStaleSeconds ?? DEFAULT_SYSTEM_CONFIG.autoPromoteStaleSeconds,
  };
}
