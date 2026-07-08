import {
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { WsConnectionEntity } from "@bifrost/dynamo-schema";
import {
  wsConnectionKey,
  toWsConnectionItem,
  fromWsConnectionItem,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

const CONNECTION_TTL_SECONDS = 2 * 60 * 60; // 2 hours

export async function putConnection(connectionId: string): Promise<void> {
  const item = toWsConnectionItem({
    connectionId,
    connectedAt: new Date().toISOString(),
    ttlSeconds: CONNECTION_TTL_SECONDS,
  });
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: wsConnectionKey(connectionId),
    }),
  );
}

export async function getAllConnections(): Promise<readonly WsConnectionEntity[]> {
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "begins_with(PK, :prefix)",
      ExpressionAttributeValues: {
        ":prefix": "WSCONN#",
      },
    }),
  );
  return (result.Items ?? []).map(fromWsConnectionItem);
}
