import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { PeerEntity, UpdatePeerInput } from "@bifrost/dynamo-schema";
import {
  peerKey,
  fromPeerItem,
  toPeerItem,
  type PeerInput,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

export async function getPeer(peerId: string): Promise<PeerEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );
  return result.Item ? fromPeerItem(result.Item) : undefined;
}

export async function putPeer(input: PeerInput): Promise<PeerEntity> {
  const item = toPeerItem(input);
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
  return item;
}

export async function deletePeer(peerId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );
}

export async function updatePeer(
  peerId: string,
  updates: UpdatePeerInput,
): Promise<void> {
  const expressions: string[] = ["#updatedAt = :now"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };

  if (updates.name !== undefined) {
    expressions.push("#name = :name");
    names["#name"] = "name";
    values[":name"] = updates.name;
  }
  if (updates.allowedIps !== undefined) {
    expressions.push("#allowedIps = :allowedIps");
    names["#allowedIps"] = "allowedIps";
    values[":allowedIps"] = updates.allowedIps;
  }
  if (updates.enabled !== undefined) {
    expressions.push("#enabled = :enabled");
    names["#enabled"] = "enabled";
    values[":enabled"] = updates.enabled;
  }

  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
      UpdateExpression: `SET ${expressions.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

export async function queryPeersByServer(
  serverId: string,
): Promise<readonly PeerEntity[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `PEER_SERVER#${serverId}`,
      },
    }),
  );
  return (result.Items ?? []).map(fromPeerItem);
}
