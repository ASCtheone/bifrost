import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { deletePeer } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const peerId = event.pathParameters?.["peerId"];
    if (!peerId) throw new HttpError(400, "Missing peerId");

    await deletePeer(peerId);

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
