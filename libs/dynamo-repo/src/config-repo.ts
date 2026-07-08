import { GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  VpnConfigEntity,
  VpnServerConfig,
  VpnPeerDefaults,
} from "@bifrost/dynamo-schema";
import {
  vpnConfigKey,
  fromVpnConfigItem,
  toVpnConfigItem,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

export async function getVpnConfig(): Promise<VpnConfigEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: vpnConfigKey(),
    }),
  );
  return result.Item ? fromVpnConfigItem(result.Item) : undefined;
}

export interface UpdateVpnConfigParams {
  readonly server?: Partial<VpnServerConfig>;
  readonly defaults?: Partial<VpnPeerDefaults>;
  readonly updatedBy: string;
}

export async function updateVpnConfig(
  params: UpdateVpnConfigParams,
): Promise<void> {
  const existing = await getVpnConfig();
  const now = new Date().toISOString();

  if (!existing) {
    // First write — create the item
    const item = toVpnConfigItem({
      configVersion: 1,
      server: (params.server ?? {}) as VpnServerConfig,
      defaults: (params.defaults ?? {}) as VpnPeerDefaults,
      updatedAt: now,
      updatedBy: params.updatedBy,
    });
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: item as unknown as Record<string, unknown>,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
    return;
  }

  // Merge updates into existing
  const newServer: VpnServerConfig = {
    ...existing.server,
    ...params.server,
  };
  const newDefaults: VpnPeerDefaults = {
    ...existing.defaults,
    ...params.defaults,
  };

  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: vpnConfigKey(),
      UpdateExpression:
        "SET #server = :server, #defaults = :defaults, #ver = #ver + :one, #updatedAt = :now, #updatedBy = :by",
      ExpressionAttributeNames: {
        "#server": "server",
        "#defaults": "defaults",
        "#ver": "configVersion",
        "#updatedAt": "updatedAt",
        "#updatedBy": "updatedBy",
      },
      ExpressionAttributeValues: {
        ":server": newServer,
        ":defaults": newDefaults,
        ":one": 1,
        ":now": now,
        ":by": params.updatedBy,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

export async function incrementConfigVersion(updatedBy: string): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: vpnConfigKey(),
      UpdateExpression:
        "SET #ver = #ver + :one, #updatedAt = :now, #updatedBy = :by",
      ExpressionAttributeNames: {
        "#ver": "configVersion",
        "#updatedAt": "updatedAt",
        "#updatedBy": "updatedBy",
      },
      ExpressionAttributeValues: {
        ":one": 1,
        ":now": now,
        ":by": updatedBy,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}
