import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey } from "@bifrost/dynamo-schema";
import { deleteDevice, getDevice, queryAllNodes, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const deviceId = event.pathParameters?.["deviceId"];
    if (!deviceId) throw new HttpError(400, "Missing deviceId");

    const device = await getDevice(deviceId);
    if (!device) throw new HttpError(404, "Device not found");

    // Find matching bifrost peers across ALL nodes and queue deletions
    const peerName = `bifrost-${device.name}`;
    const allNodes = await queryAllNodes();

    for (const node of allNodes) {
      if (node.adoptionStatus !== "adopted") continue;

      // Find the peer ID on this node by matching the name in actualConfig
      const matchingPeer = node.actualConfig?.peers?.find(
        (p) => p.name === peerName,
      );

      if (matchingPeer) {
        await getDocClient().send(
          new UpdateCommand({
            TableName: getTableName(),
            Key: nodeKey(node.nodeId),
            UpdateExpression: "SET #ppd = list_append(if_not_exists(#ppd, :empty), :ids)",
            ExpressionAttributeNames: { "#ppd": "pendingPeerDeletions" },
            ExpressionAttributeValues: {
              ":ids": [matchingPeer.id],
              ":empty": [],
            },
          }),
        );
      }
    }

    await deleteDevice(deviceId);

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
