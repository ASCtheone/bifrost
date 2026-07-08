import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { deviceKey } from "@bifrost/dynamo-schema";
import { getDevice, getDocClient, getTableName, updateDeviceStatus } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);

    const deviceId = event.pathParameters?.["deviceId"];
    if (!deviceId) throw new HttpError(400, "Missing deviceId");

    const device = await getDevice(deviceId);
    if (!device) throw new HttpError(404, "Device not found");

    const body = JSON.parse(event.body ?? "{}") as {
      enabled?: boolean;
      ownerEmail?: string | null;
    };

    if (body.enabled !== undefined) {
      await updateDeviceStatus(deviceId, body.enabled);
    }

    if (body.ownerEmail !== undefined) {
      if (!auth.groups.includes("superadmin")) {
        throw new HttpError(403, "Only superadmins can reassign devices");
      }

      const now = new Date().toISOString();
      if (body.ownerEmail === null) {
        await getDocClient().send(
          new UpdateCommand({
            TableName: getTableName(),
            Key: deviceKey(deviceId),
            UpdateExpression: "SET #oe = :empty, #updatedAt = :now",
            ExpressionAttributeNames: { "#oe": "ownerEmail", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: { ":empty": "", ":now": now },
          }),
        );
      } else {
        await getDocClient().send(
          new UpdateCommand({
            TableName: getTableName(),
            Key: deviceKey(deviceId),
            UpdateExpression: "SET #oe = :oe, #updatedAt = :now",
            ExpressionAttributeNames: { "#oe": "ownerEmail", "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: { ":oe": body.ownerEmail, ":now": now },
          }),
        );
      }
    }

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
