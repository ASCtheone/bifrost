import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { incrementConfigVersion, writeAuditLog } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

interface ForceResyncInput {
  readonly nodeId?: string;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const input = JSON.parse(event.body ?? "{}") as ForceResyncInput;

    await incrementConfigVersion(auth.sub);

    const targetId = input.nodeId ?? "all";

    await writeAuditLog("config.force_resync", auth.sub, targetId, {
      scope: input.nodeId ? "single" : "all",
    });

    return ok({ success: true, target: targetId });
  } catch (err) {
    return handleError(err);
  }
}
