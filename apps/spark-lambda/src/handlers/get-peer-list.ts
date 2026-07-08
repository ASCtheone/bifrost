import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { fromPeerItem } from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const result = await getDocClient().send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "entityType = :et",
        ExpressionAttributeValues: { ":et": "Peer" },
      }),
    );

    const peers = (result.Items ?? []).map(fromPeerItem).map((p) => ({
      id: p.peerId,
      name: p.name,
      assignedIp: p.assignedIp,
      nodeId: p.nodeId,
      enabled: p.enabled,
      createdAt: p.createdAt,
    }));

    return ok({ peers });
  } catch (err) {
    return handleError(err);
  }
}
