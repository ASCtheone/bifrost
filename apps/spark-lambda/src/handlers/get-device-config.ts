import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { getDevice, queryAllNodes } from "@bifrost/dynamo-repo";
import type { NodeEntity } from "@bifrost/dynamo-schema";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

interface NodeConfig {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly serverName: string;
  readonly wgConfig: string;
  readonly serverPublicKey: string;
  readonly endpoint: string;
  readonly port: number;
}

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

function getSparkServerForNode(node: NodeEntity): { publicKey: string; port: number; subnet: string } | null {
  if (!node.sparkVpnName || !node.actualConfig?.servers) return null;
  const server = node.actualConfig.servers.find((s) => s.name === node.sparkVpnName);
  if (!server) return null;
  return {
    publicKey: server.publicKey,
    port: server.serverPort,
    subnet: server.serverAddress,
  };
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const deviceId = event.pathParameters?.["deviceId"];
    if (!deviceId) throw new HttpError(400, "Missing deviceId");

    const device = await getDevice(deviceId);
    if (!device) throw new HttpError(404, "Device not found");

    // Build a config for each adopted node owned by the device's owner chain
    const allNodes = await queryAllNodes();
    const deviceOwner = (device as unknown as { ownerEmail?: string }).ownerEmail ?? "";
    const configs: NodeConfig[] = [];

    for (const node of allNodes) {
      if (node.adoptionStatus !== "adopted") continue;
      // Only use sparks owned by the device's owner (or their admin)
      const nodeOwner = (node as unknown as { ownerEmail?: string }).ownerEmail ?? "";
      if (nodeOwner && deviceOwner && nodeOwner !== deviceOwner) continue;

      const server = getSparkServerForNode(node);
      if (!server || !server.publicKey) continue;

      const wanIp = (node as unknown as { wanIp?: string }).wanIp;
      if (!wanIp) continue;

      const wgConfig = buildWgConfig({
        privateKey: device.privateKey,
        assignedIp: device.assignedIp,
        dns: device.dns,
        serverPublicKey: server.publicKey,
        endpoint: wanIp,
        port: server.port,
        presharedKey: device.presharedKey,
        allowedIps: device.allowedIps,
      });

      configs.push({
        nodeId: node.nodeId,
        nodeName: node.nodeName ?? node.nodeId,
        serverName: node.sparkVpnName ?? "",
        wgConfig,
        serverPublicKey: server.publicKey,
        endpoint: wanIp,
        port: server.port,
      });
    }

    // Primary config = first available (or the device's assigned node)
    const primaryConfig = configs.find((c) => c.nodeId === device.nodeId) ?? configs[0];

    return ok({
      deviceId: device.deviceId,
      name: device.name,
      assignedIp: device.assignedIp,
      provisionToken: device.provisionToken,
      config: primaryConfig?.wgConfig ?? "",
      configs,
    });
  } catch (err) {
    return handleError(err);
  }
}
