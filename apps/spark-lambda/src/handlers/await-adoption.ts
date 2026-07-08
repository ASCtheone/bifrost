import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { getNode, getNodeByAdoptionCode, getPendingKey, deletePendingKey } from "@bifrost/dynamo-repo";
import { HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const code = event.queryStringParameters?.["code"];
    const nodeId = event.queryStringParameters?.["nodeId"];

    if (!code && !nodeId) {
      throw new HttpError(400, "Missing code or nodeId parameter");
    }

    // Try to find the node — first by nodeId (faster, works after adoption clears GSI3),
    // then by adoption code (works before adoption)
    let node;
    if (nodeId) {
      node = await getNode(nodeId);
    }
    if (!node && code) {
      node = await getNodeByAdoptionCode(code);
    }

    if (!node) {
      throw new HttpError(404, "Node not found");
    }

    if (node.adoptionStatus === "pending" || node.adoptionStatus === "available") {
      return ok({ status: "waiting" });
    }

    if (node.adoptionStatus === "adopted") {
      const pending = await getPendingKey(node.nodeId);
      if (!pending) {
        return ok({ status: "adopted", nodeKey: null });
      }

      await deletePendingKey(node.nodeId);
      return ok({ status: "adopted", nodeKey: pending.rawKey });
    }

    throw new HttpError(400, `Unexpected adoption status: ${node.adoptionStatus}`);
  } catch (err) {
    return handleError(err);
  }
}
