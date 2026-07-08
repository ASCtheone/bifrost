import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { getNode, deleteNode, writeAuditLog } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const nodeId = event.pathParameters?.["nodeId"];

    if (!nodeId) {
      throw new HttpError(400, "nodeId is required");
    }

    const node = await getNode(nodeId);
    if (!node) {
      throw new HttpError(404, `Node ${nodeId} not found`);
    }

    if (node.role === "primary") {
      throw new HttpError(
        409,
        "Cannot remove primary node. Promote another node first.",
      );
    }

    await deleteNode(nodeId);

    await writeAuditLog("node.removed", auth.sub, nodeId, {
      tunnelId: node.tunnelId,
    });

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
