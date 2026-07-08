import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey } from "@bifrost/dynamo-schema";
import { getNode, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    if (node.sparkVpnName) {
      throw new HttpError(409, `VPN already exists: ${node.sparkVpnName}`);
    }

    const vpnName = "SPARK VPN";
    const now = new Date().toISOString();

    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: nodeKey(nodeId),
        UpdateExpression: "SET #svn = :svn, #pvc = :pvc, #updatedAt = :now",
        ExpressionAttributeNames: {
          "#svn": "sparkVpnName",
          "#pvc": "pendingVpnCreate",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":svn": vpnName,
          ":pvc": true,
          ":now": now,
        },
      }),
    );

    return ok({ success: true, vpnName });
  } catch (err) {
    return handleError(err);
  }
}
