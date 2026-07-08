import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { getNode, revokeNodeKey } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    if (node.adoptionStatus !== "adopted") {
      throw new HttpError(400, `Cannot revoke key for node in ${node.adoptionStatus} state`);
    }

    await revokeNodeKey(nodeId);

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
