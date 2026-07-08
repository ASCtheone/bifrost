import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";
import { randomBytes } from "node:crypto";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const deviceId = event.pathParameters?.["deviceId"];
    if (!deviceId) return ok({ logs: [] });

    const method = event.requestContext.http.method;

    if (method === "POST") {
      // Log a connection event from the app
      const body = JSON.parse(event.body ?? "{}") as {
        action?: string;
        connectedNodeId?: string;
        connectedNodeName?: string;
        clientIp?: string;
        location?: string;
      };

      await getDocClient().send(
        new PutCommand({
          TableName: getTableName(),
          Item: {
            PK: `CONN_LOG#${deviceId}`,
            SK: `${new Date().toISOString()}#${randomBytes(4).toString("hex")}`,
            entityType: "ConnectionLog",
            deviceId,
            action: body.action ?? "connect",
            connectedNodeId: body.connectedNodeId ?? null,
            connectedNodeName: body.connectedNodeName ?? null,
            sourceIp: body.clientIp ?? event.requestContext?.http?.sourceIp ?? "unknown",
            location: body.location ?? null,
            userAgent: event.headers?.["user-agent"] ?? "unknown",
            timestamp: new Date().toISOString(),
            ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
          },
        }),
      );

      return ok({ success: true });
    }

    // GET — fetch logs
    const result = await getDocClient().send(
      new QueryCommand({
        TableName: getTableName(),
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": `CONN_LOG#${deviceId}` },
        ScanIndexForward: false,
        Limit: 50,
      }),
    );

    const logs = (result.Items ?? []).map((item) => ({
      action: item["action"] as string,
      sourceIp: item["sourceIp"] as string,
      location: item["location"] as string | null,
      connectedNodeName: item["connectedNodeName"] as string | null,
      userAgent: item["userAgent"] as string,
      timestamp: item["timestamp"] as string,
    }));

    return ok({ logs });
  } catch (err) {
    return handleError(err);
  }
}
