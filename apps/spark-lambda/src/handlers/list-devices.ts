import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { queryAllDevices } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const isSuperadmin = auth.groups.includes("superadmin");

    const allDevices = await queryAllDevices();

    // Superadmins see all, others see only their own (unowned devices only visible to superadmins)
    const filtered = isSuperadmin
      ? allDevices
      : allDevices.filter((d) => {
          const ownerEmail = (d as unknown as { ownerEmail?: string }).ownerEmail;
          return ownerEmail === auth.email;
        });

    const result = filtered.map((d) => ({
      id: d.deviceId,
      name: d.name,
      type: d.type,
      status: d.status,
      assignedIp: d.assignedIp,
      publicKey: d.publicKey,
      enabled: d.enabled,
      nodeId: d.nodeId,
      provisionMethod: d.provisionMethod,
      ownerEmail: (d as unknown as { ownerEmail?: string }).ownerEmail ?? null,
      lastSeen: d.lastSeen,
      createdAt: d.createdAt,
    }));

    return ok({ devices: result });
  } catch (err) {
    return handleError(err);
  }
}
