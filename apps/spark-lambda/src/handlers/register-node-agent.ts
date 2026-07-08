import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { updateAdoptionStatus } from "@bifrost/dynamo-repo";
import { validateAdoptionCode, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const { nodeId } = await validateAdoptionCode(event);

    // Only pending nodes can be registered
    const { getNode } = await import("@bifrost/dynamo-repo");
    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    if (node.adoptionStatus !== "pending") {
      throw new HttpError(409, `Node is already ${node.adoptionStatus}`);
    }

    await updateAdoptionStatus(nodeId, "available");

    return ok({ success: true, nodeId });
  } catch (err) {
    return handleError(err);
  }
}
