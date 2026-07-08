import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { PutCommand, DeleteCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey } from "@bifrost/dynamo-schema";
import { getNode, getDocClient, getTableName, queryAllDevices } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

async function cleanupSharedPeers(nodeId: string, unsharedEmail: string): Promise<void> {
  const db = getDocClient();
  const tableName = getTableName();

  // Find all devices owned by the unshared user
  const allDevices = await queryAllDevices();
  const userDevices = allDevices.filter((d) => {
    const ownerEmail = (d as unknown as { ownerEmail?: string }).ownerEmail;
    return ownerEmail === unsharedEmail;
  });

  if (userDevices.length === 0) return;

  // Get the node's actual config to find peer IDs
  const node = await getNode(nodeId);
  if (!node?.actualConfig?.peers) return;

  const peerIdsToDelete: string[] = [];
  for (const device of userDevices) {
    const peerName = `bifrost-${device.name}`;
    const match = node.actualConfig.peers.find((p) => p.name === peerName);
    if (match) {
      peerIdsToDelete.push(match.id);
    }
  }

  if (peerIdsToDelete.length === 0) return;

  // Queue peer deletions on the node
  await db.send(
    new UpdateCommand({
      TableName: tableName,
      Key: nodeKey(nodeId),
      UpdateExpression: "SET #ppd = list_append(if_not_exists(#ppd, :empty), :ids)",
      ExpressionAttributeNames: { "#ppd": "pendingPeerDeletions" },
      ExpressionAttributeValues: {
        ":ids": peerIdsToDelete,
        ":empty": [],
      },
    }),
  );
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Spark not found");

    const nodeOwner = (node as unknown as { ownerEmail?: string }).ownerEmail;
    const isSuperadmin = auth.groups.includes("superadmin");
    if (nodeOwner !== auth.email && !isSuperadmin) {
      throw new HttpError(403, "Only the spark owner can manage sharing");
    }

    const method = event.requestContext.http.method;
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};

    if (method === "POST") {
      const email = body["email"] as string;
      if (!email) throw new HttpError(400, "Email is required");
      const action = body["action"] as string;

      if (action === "remove") {
        // Delete share record
        await getDocClient().send(
          new DeleteCommand({
            TableName: getTableName(),
            Key: { PK: `SPARK_SHARE#${nodeId}`, SK: `SHARE#${email}` },
          }),
        );

        // Cleanup: remove WireGuard peers for this user's devices from the spark
        await cleanupSharedPeers(nodeId, email);

        return ok({ success: true });
      }

      // Validate sharing permissions
      if (!isSuperadmin) {
        const ownershipResult = await getDocClient().send(
          new ScanCommand({
            TableName: getTableName(),
            FilterExpression: "entityType = :et AND userEmail = :ue",
            ExpressionAttributeValues: { ":et": "UserOwnership", ":ue": email },
          }),
        );
        const targetOwner = ownershipResult.Items?.[0]?.["ownerEmail"] as string | undefined;
        if (targetOwner && targetOwner !== auth.email) {
          throw new HttpError(403, "Cannot share with users owned by another admin");
        }
      }

      // Create share
      await getDocClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            PK: `SPARK_SHARE#${nodeId}`,
            SK: `SHARE#${email}`,
            entityType: "SparkShare",
            nodeId,
            sharedWithEmail: email,
            sharedByEmail: auth.email,
            createdAt: new Date().toISOString(),
          },
        }),
      );

      return ok({ success: true });
    }

    if (method === "GET") {
      const result = await getDocClient().send(
        new ScanCommand({
          TableName: getTableName(),
          FilterExpression: "entityType = :et AND nodeId = :nid",
          ExpressionAttributeValues: { ":et": "SparkShare", ":nid": nodeId },
        }),
      );

      const shares = (result.Items ?? []).map((item) => ({
        email: item["sharedWithEmail"] as string,
        sharedBy: item["sharedByEmail"] as string,
        createdAt: item["createdAt"] as string,
      }));

      return ok({ shares });
    }

    throw new HttpError(405, "Method not allowed");
  } catch (err) {
    return handleError(err);
  }
}
