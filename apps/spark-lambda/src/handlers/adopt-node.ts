import { randomBytes, createHash } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { getNode, setNodeKeyHash, putPendingKey } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const nodeId = event.pathParameters?.["nodeId"];
    if (!nodeId) throw new HttpError(400, "Missing nodeId");

    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Node not found");

    if (node.adoptionStatus !== "available") {
      throw new HttpError(400, `Cannot adopt node in ${node.adoptionStatus} state`);
    }

    // Generate cryptographically secure node key
    const rawKey = randomBytes(32).toString("hex");
    const keyHash = createHash("sha256").update(rawKey).digest("hex");

    // Store hash on node, remove adoption code + GSI3
    await setNodeKeyHash(nodeId, keyHash);

    // Store raw key temporarily for spark-agent to pick up (5 min TTL)
    await putPendingKey(nodeId, rawKey);

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
