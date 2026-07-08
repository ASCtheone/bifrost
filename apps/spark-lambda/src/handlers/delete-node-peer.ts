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

    const body = JSON.parse(event.body ?? "{}") as { peerId?: string };
    if (!body.peerId) throw new HttpError(400, "Missing peerId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    // Queue the peer deletion on the node
    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: nodeKey(nodeId),
        UpdateExpression: "SET #ppd = list_append(if_not_exists(#ppd, :empty), :ids)",
        ExpressionAttributeNames: { "#ppd": "pendingPeerDeletions" },
        ExpressionAttributeValues: {
          ":ids": [body.peerId],
          ":empty": [],
        },
      }),
    );

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
