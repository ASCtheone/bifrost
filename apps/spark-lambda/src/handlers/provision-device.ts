import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { getDeviceByToken, queryAllNodes } from "@bifrost/dynamo-repo";
import { HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

function buildWgConfig(opts: {
  privateKey: string;
  assignedIp: string;
  dns: readonly string[];
  serverPublicKey: string;
  endpoint: string;
  port: number;
  presharedKey: string;
  allowedIps: readonly string[];
}): string {
  return [
    "[Interface]",
    `PrivateKey = ${opts.privateKey}`,
    `Address = ${opts.assignedIp}/32`,
    `DNS = ${opts.dns.join(", ")}`,
    "",
    "[Peer]",
    `PublicKey = ${opts.serverPublicKey}`,
    `PresharedKey = ${opts.presharedKey}`,
    `Endpoint = ${opts.endpoint}:${opts.port}`,
    `AllowedIPs = ${opts.allowedIps.join(", ")}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const token = event.pathParameters?.["token"];
    if (!token) throw new HttpError(400, "Missing provision token");

    const device = await getDeviceByToken(token);
    if (!device) throw new HttpError(404, "Invalid provision token");
    if (device.status === "revoked") throw new HttpError(403, "Device has been revoked");

    const allNodes = await queryAllNodes();
    const nodes: {
      nodeId: string;
      name: string;
      serverName: string;
      endpoint: string;
      port: number;
      wgConfig: string;
      location: string | null;
      role: string;
      ispName: string | null;
      speedDown: number | null;
      speedUp: number | null;
    }[] = [];

    const deviceOwner = (device as unknown as { ownerEmail?: string }).ownerEmail ?? "";

    for (const node of allNodes) {
      if (node.adoptionStatus !== "adopted") continue;
      const nodeOwner = (node as unknown as { ownerEmail?: string }).ownerEmail ?? "";
      if (nodeOwner && deviceOwner && nodeOwner !== deviceOwner) continue;
      const server = node.actualConfig?.servers?.find((s) => s.name === node.sparkVpnName);
      if (!server?.publicKey) continue;
      const wanIp = (node as unknown as { wanIp?: string }).wanIp;
      if (!wanIp) continue;
      const geo = (node as unknown as { geo?: { city?: string; country?: string; region?: string } }).geo;

      nodes.push({
        nodeId: node.nodeId,
        name: node.nodeName ?? node.nodeId,
        serverName: node.sparkVpnName ?? "",
        endpoint: wanIp,
        port: server.serverPort,
        location: geo ? `${geo.city}, ${geo.country}` : null,
        role: node.role,
        ispName: (node as unknown as { ispName?: string }).ispName ?? null,
        speedDown: (node as unknown as { speedDown?: number }).speedDown ?? null,
        speedUp: (node as unknown as { speedUp?: number }).speedUp ?? null,
        wgConfig: buildWgConfig({
          privateKey: device.privateKey,
          assignedIp: device.assignedIp,
          dns: device.dns,
          serverPublicKey: server.publicKey,
          endpoint: wanIp,
          port: server.serverPort,
          presharedKey: device.presharedKey,
          allowedIps: device.allowedIps,
        }),
      });
    }

    return ok({
      deviceId: device.deviceId,
      name: device.name,
      type: device.type,
      assignedIp: device.assignedIp,
      nodes,
      // Primary config for backwards compat
      config: nodes[0]?.wgConfig ?? "",
    });
  } catch (err) {
    return handleError(err);
  }
}
