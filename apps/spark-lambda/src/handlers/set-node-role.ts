import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  getNode,
  queryNodesByRole,
  updateNodeRole,
  writeAuditLog,
} from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

interface SetNodeRoleInput {
  readonly role: "primary" | "secondary";
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const nodeId = event.pathParameters?.["nodeId"];
    const input = JSON.parse(event.body ?? "{}") as SetNodeRoleInput;

    if (!nodeId) {
      throw new HttpError(400, "nodeId is required");
    }

    if (input.role !== "primary" && input.role !== "secondary") {
      throw new HttpError(400, "role must be 'primary' or 'secondary'");
    }

    const node = await getNode(nodeId);
    if (!node) {
      throw new HttpError(404, `Node ${nodeId} not found`);
    }

    if (node.role === input.role) {
      return ok({ success: true, message: "No change needed" });
    }

    if (input.role === "primary") {
      // Demote all current primaries to secondary
      const primaries = await queryNodesByRole("primary");
      for (const primary of primaries) {
        await updateNodeRole(primary.nodeId, "secondary", primary.priority);
      }
    }

    await updateNodeRole(nodeId, input.role, node.priority);

    const action = input.role === "primary" ? "node.promoted" : "node.demoted";
    await writeAuditLog(action, auth.sub, nodeId, {
      newRole: input.role,
    });

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
