import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { deviceKey } from "@bifrost/dynamo-schema";
import { getDevice, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const deviceId = event.pathParameters?.["deviceId"];
    if (!deviceId) throw new HttpError(400, "Missing deviceId");

    const device = await getDevice(deviceId);
    if (!device) throw new HttpError(404, "Device not found");

    // Reset unifiPeerId and status to pending — agent will re-create the peer
    const now = new Date().toISOString();
    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: deviceKey(deviceId),
        UpdateExpression: "SET #status = :pending, #updatedAt = :now REMOVE #upid",
        ExpressionAttributeNames: {
          "#status": "status",
          "#updatedAt": "updatedAt",
          "#upid": "unifiPeerId",
        },
        ExpressionAttributeValues: {
          ":pending": "pending",
          ":now": now,
        },
      }),
    );

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
