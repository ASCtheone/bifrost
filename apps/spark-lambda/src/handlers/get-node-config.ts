import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { getNode } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    if (node.adoptionStatus !== "pending" && node.adoptionStatus !== "available") {
      throw new HttpError(400, "Node has already been adopted");
    }

    const apiUrl = process.env["BIFROST_API_URL"] ?? "";
    const wsUrl = process.env["BIFROST_WS_URL"] ?? "";

    return ok({
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      adoptionCode: node.adoptionCode,
      apiUrl,
      wsUrl,
    });
  } catch (err) {
    return handleError(err);
  }
}
