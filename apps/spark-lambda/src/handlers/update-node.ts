import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey } from "@bifrost/dynamo-schema";
import { getNode, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

interface UpdateNodeBody {
  readonly name?: string;
  readonly controllerUrl?: string;
  readonly controllerApiKey?: string;
  readonly tunnelUrl?: string;
  readonly tunnelId?: string;
  readonly priority?: number;
  readonly assignToEmail?: string | null;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    const body = JSON.parse(event.body ?? "{}") as UpdateNodeBody;

    const updates: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (body.name !== undefined) {
      updates.push("#nodeName = :nodeName");
      names["#nodeName"] = "nodeName";
      values[":nodeName"] = body.name;
    }
    if (body.controllerUrl !== undefined) {
      updates.push("#controllerUrl = :controllerUrl");
      names["#controllerUrl"] = "controllerUrl";
      values[":controllerUrl"] = body.controllerUrl;
    }
    if (body.controllerApiKey !== undefined) {
      updates.push("#controllerApiKey = :controllerApiKey");
      names["#controllerApiKey"] = "controllerApiKey";
      values[":controllerApiKey"] = body.controllerApiKey;
    }
    if (body.tunnelUrl !== undefined) {
      updates.push("#tunnelUrl = :tunnelUrl");
      names["#tunnelUrl"] = "tunnelUrl";
      values[":tunnelUrl"] = body.tunnelUrl;
    }
    if (body.tunnelId !== undefined) {
      updates.push("#tunnelId = :tunnelId");
      names["#tunnelId"] = "tunnelId";
      values[":tunnelId"] = body.tunnelId;
    }
    if (body.priority !== undefined) {
      updates.push("#priority = :priority");
      names["#priority"] = "priority";
      values[":priority"] = body.priority;
    }
    if (body.assignToEmail !== undefined) {
      if (body.assignToEmail === null) {
        // Unassign
        updates.push("#ownerId = :emptyStr, #ownerEmail = :emptyStr");
        names["#ownerId"] = "ownerId";
        names["#ownerEmail"] = "ownerEmail";
        values[":emptyStr"] = "";
      } else {
        // Assign — store email as owner, use email as ID for simplicity
        updates.push("#ownerId = :oid, #ownerEmail = :oemail");
        names["#ownerId"] = "ownerId";
        names["#ownerEmail"] = "ownerEmail";
        values[":oid"] = body.assignToEmail;
        values[":oemail"] = body.assignToEmail;
      }
    }

    if (updates.length === 0) {
      throw new HttpError(400, "No fields to update");
    }

    updates.push("#updatedAt = :now");
    names["#updatedAt"] = "updatedAt";
    values[":now"] = new Date().toISOString();

    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: nodeKey(nodeId),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(PK)",
      }),
    );

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
