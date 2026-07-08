import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { getNode, queryDevicesByNode } from "@bifrost/dynamo-repo";
import { validateNodeKey } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const { nodeId } = await validateNodeKey(event);

    const node = await getNode(nodeId);
    if (!node) return ok({ node: null });

    // Get devices that need peers created on this node
    const devices = await queryDevicesByNode(nodeId);
    const pendingDevices = devices
      .filter((d) => d.enabled && !d.unifiPeerId)
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        publicKey: d.publicKey,
        presharedKey: d.presharedKey,
        assignedIp: d.assignedIp,
      }));

    return ok({
      node: {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        controllerUrl: node.controllerUrl ?? "",
        controllerApiKey: node.controllerApiKey ?? "",
        priority: node.priority,
        role: node.role,
        sparkVpnName: node.sparkVpnName ?? null,
        sparkVpnId: node.sparkVpnId ?? null,
        pendingVpnCreate: node.pendingVpnCreate ?? false,
        pendingDevices,
        pendingPeerDeletions: (node as unknown as { pendingPeerDeletions?: string[] }).pendingPeerDeletions ?? [],
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
