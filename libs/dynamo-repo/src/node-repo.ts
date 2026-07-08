import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { NodeEntity, NodeRole, AdoptionStatus, PendingKeyEntity } from "@bifrost/dynamo-schema";
import {
  nodeKey,
  nodeRoleGsi1,
  pendingKeyKey,
  fromNodeItem,
  toNodeItem,
  toPendingKeyItem,
  fromPendingKeyItem,
  type NodeInput,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

// ── Basic CRUD ──────────────────────────────────────────────────

export async function getNode(nodeId: string): Promise<NodeEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
    }),
  );
  return result.Item ? fromNodeItem(result.Item) : undefined;
}

export async function putNode(input: NodeInput): Promise<NodeEntity> {
  const item = toNodeItem(input);
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
  return item;
}

export async function putNodeIfNotExists(input: NodeInput): Promise<NodeEntity> {
  const item = toNodeItem(input);
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return item;
}

export async function deleteNode(nodeId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
    }),
  );
}

// ── Role Management ─────────────────────────────────────────────

export async function updateNodeRole(
  nodeId: string,
  role: NodeRole,
  priority: number,
): Promise<void> {
  const now = new Date().toISOString();
  const gsi1 = nodeRoleGsi1(role, priority, nodeId);
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
      UpdateExpression:
        "SET #role = :role, #updatedAt = :now, #GSI1PK = :gsi1pk, #GSI1SK = :gsi1sk",
      ExpressionAttributeNames: {
        "#role": "role",
        "#updatedAt": "updatedAt",
        "#GSI1PK": "GSI1PK",
        "#GSI1SK": "GSI1SK",
      },
      ExpressionAttributeValues: {
        ":role": role,
        ":now": now,
        ":gsi1pk": gsi1.GSI1PK,
        ":gsi1sk": gsi1.GSI1SK,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

// ── Queries ─────────────────────────────────────────────────────

export async function queryNodesByRole(role: NodeRole): Promise<readonly NodeEntity[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `NODE_ROLE#${role}`,
      },
    }),
  );
  return (result.Items ?? []).map(fromNodeItem);
}

export async function queryOnlineSecondariesByPriority(
  limit = 1,
): Promise<readonly NodeEntity[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      FilterExpression: "#status = :online",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":pk": "NODE_ROLE#secondary",
        ":online": "online",
      },
      Limit: limit * 5,
    }),
  );
  return (result.Items ?? []).map(fromNodeItem).slice(0, limit);
}

export async function queryAllNodes(): Promise<readonly NodeEntity[]> {
  // Scan for all Node entities (small table, fine for admin use)
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "entityType = :et",
      ExpressionAttributeValues: { ":et": "Node" },
    }),
  );
  return (result.Items ?? []).map(fromNodeItem);
}

// ── Adoption Flow ───────────────────────────────────────────────

export async function getNodeByAdoptionCode(code: string): Promise<NodeEntity | undefined> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `ADOPTION#${code}`,
      },
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  return item ? fromNodeItem(item) : undefined;
}

export async function updateAdoptionStatus(
  nodeId: string,
  adoptionStatus: AdoptionStatus,
): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
      UpdateExpression: "SET #as = :as, #updatedAt = :now",
      ExpressionAttributeNames: {
        "#as": "adoptionStatus",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":as": adoptionStatus,
        ":now": now,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

export async function setNodeKeyHash(
  nodeId: string,
  keyHash: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
      UpdateExpression:
        "SET #nkh = :nkh, #kia = :now, #as = :adopted, #updatedAt = :now REMOVE #ac, #cea, #GSI3PK, #GSI3SK",
      ExpressionAttributeNames: {
        "#nkh": "nodeKeyHash",
        "#kia": "keyIssuedAt",
        "#as": "adoptionStatus",
        "#updatedAt": "updatedAt",
        "#ac": "adoptionCode",
        "#cea": "codeExpiresAt",
        "#GSI3PK": "GSI3PK",
        "#GSI3SK": "GSI3SK",
      },
      ExpressionAttributeValues: {
        ":nkh": keyHash,
        ":now": now,
        ":adopted": "adopted",
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

export async function revokeNodeKey(nodeId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: nodeKey(nodeId),
      UpdateExpression: "SET #as = :revoked, #updatedAt = :now REMOVE #nkh, #kia",
      ExpressionAttributeNames: {
        "#as": "adoptionStatus",
        "#updatedAt": "updatedAt",
        "#nkh": "nodeKeyHash",
        "#kia": "keyIssuedAt",
      },
      ExpressionAttributeValues: {
        ":revoked": "revoked",
        ":now": now,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}

// ── Pending Key (temporary raw key for adoption handoff) ────────

export async function putPendingKey(nodeId: string, rawKey: string): Promise<void> {
  const item = toPendingKeyItem({ nodeId, rawKey, ttlSeconds: 300 });
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
}

export async function getPendingKey(nodeId: string): Promise<PendingKeyEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: pendingKeyKey(nodeId),
    }),
  );
  return result.Item ? fromPendingKeyItem(result.Item) : undefined;
}

export async function deletePendingKey(nodeId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: pendingKeyKey(nodeId),
    }),
  );
}
