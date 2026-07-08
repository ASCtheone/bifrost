import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { putDevice, queryAllNodes, queryAllDevices, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

function generateDeviceId(): string {
  return `dev-${randomBytes(4).toString("hex")}`;
}

function generateProvisionToken(): string {
  return randomBytes(24).toString("base64url");
}

function generateWgKeypair(): { privateKey: string; publicKey: string } {
  const kp = generateKeyPairSync("x25519");
  return {
    privateKey: kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64"),
    publicKey: kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64"),
  };
}

async function getUserOwner(email: string): Promise<string | null> {
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "entityType = :et AND userEmail = :ue",
      ExpressionAttributeValues: { ":et": "UserOwnership", ":ue": email },
    }),
  );
  return (result.Items?.[0]?.["ownerEmail"] as string) ?? null;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const isSuperadmin = auth.groups.includes("superadmin");
    const isAdmin = auth.groups.includes("admin");

    // Find or create device for this user
    const allDevices = await queryAllDevices();
    let device = allDevices.find((d) => {
      const ownerEmail = (d as unknown as { ownerEmail?: string }).ownerEmail;
      return ownerEmail === auth.email;
    });

    // Determine spark owner
    let sparkOwnerEmail = auth.email;
    if (!isSuperadmin && !isAdmin) {
      const owner = await getUserOwner(auth.email);
      if (owner) sparkOwnerEmail = owner;
    }

    // Find owner's sparks + shared sparks
    const sharedResult = await getDocClient().send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "entityType = :et AND sharedWithEmail = :email",
        ExpressionAttributeValues: { ":et": "SparkShare", ":email": sparkOwnerEmail },
      }),
    );
    const sharedNodeIds = new Set((sharedResult.Items ?? []).map((i) => i["nodeId"] as string));

    const allNodes = await queryAllNodes();
    const ownerNodes = allNodes.filter((n) => {
      const nodeOwner = (n as unknown as { ownerEmail?: string }).ownerEmail;
      return n.adoptionStatus === "adopted" && (nodeOwner === sparkOwnerEmail || sharedNodeIds.has(n.nodeId));
    });

    if (!device && ownerNodes.length > 0) {
      // Auto-create device
      const node = ownerNodes[0]!;
      const sparkServer = node.actualConfig?.servers?.find((s) => s.name === node.sparkVpnName);
      const deviceId = generateDeviceId();
      const { privateKey, publicKey } = generateWgKeypair();
      const presharedKey = randomBytes(32).toString("base64");
      const provisionToken = generateProvisionToken();
      const now = new Date().toISOString();
      const serverAddress = sparkServer?.serverAddress ?? "192.168.8.1/24";
      const subnetBase = serverAddress.split("/")[0]!.split(".").slice(0, 3).join(".");
      const hash = createHash("md5").update(deviceId).digest();
      const octet4 = (hash[0]! % 250) + 2;
      const assignedIp = `${subnetBase}.${octet4}`;

      device = await putDevice({
        deviceId,
        nodeId: node.nodeId,
        name: auth.email.split("@")[0] ?? "device",
        type: "phone",
        status: "pending",
        provisionMethod: "headless",
        provisionToken,
        assignedIp,
        publicKey,
        privateKey,
        presharedKey,
        serverPublicKey: sparkServer?.publicKey ?? "",
        serverEndpoint: node.controllerUrl ?? "",
        serverPort: sparkServer?.serverPort ?? 51830,
        dns: ["1.1.1.1", "8.8.8.8"],
        allowedIps: ["0.0.0.0/0"],
        unifiPeerId: null,
        enabled: true,
        lastSeen: null,
        createdBy: auth.sub,
        ownerEmail: auth.email,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (!device) {
      return ok({
        provisioned: false,
        message: "No sparks available for your account",
      });
    }

    // Build VPN configs for all accessible nodes
    const nodes: {
      nodeId: string;
      name: string;
      endpoint: string;
      port: number;
      wgConfig: string;
      location: string | null;
      role: string;
      ispName: string | null;
      speedDown: number | null;
      speedUp: number | null;
    }[] = [];

    for (const node of ownerNodes) {
      const server = node.actualConfig?.servers?.find((s) => s.name === node.sparkVpnName);
      if (!server?.publicKey) continue;
      const wanIp = (node as unknown as { wanIp?: string }).wanIp;
      if (!wanIp) continue;
      const geo = (node as unknown as { geo?: { city?: string; country?: string } }).geo;

      nodes.push({
        nodeId: node.nodeId,
        name: node.nodeName ?? node.nodeId,
        endpoint: wanIp,
        port: server.serverPort,
        location: geo ? `${geo.city}, ${geo.country}` : null,
        role: node.role,
        ispName: (node as unknown as { ispName?: string }).ispName ?? null,
        speedDown: (node as unknown as { speedDown?: number }).speedDown ?? null,
        speedUp: (node as unknown as { speedUp?: number }).speedUp ?? null,
        wgConfig: [
          "[Interface]",
          `PrivateKey = ${device.privateKey}`,
          `Address = ${device.assignedIp}/32`,
          `DNS = ${device.dns.join(", ")}`,
          "",
          "[Peer]",
          `PublicKey = ${server.publicKey}`,
          `PresharedKey = ${device.presharedKey}`,
          `Endpoint = ${wanIp}:${server.serverPort}`,
          `AllowedIPs = ${device.allowedIps.join(", ")}`,
          "PersistentKeepalive = 25",
          "",
        ].join("\n"),
      });
    }

    // Log the connection attempt
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          PK: `CONN_LOG#${device.deviceId}`,
          SK: `${new Date().toISOString()}#${randomBytes(4).toString("hex")}`,
          entityType: "ConnectionLog",
          deviceId: device.deviceId,
          userEmail: auth.email,
          action: "provision",
          sourceIp: event.requestContext?.http?.sourceIp ?? "unknown",
          userAgent: event.headers?.["user-agent"] ?? "unknown",
          timestamp: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days
        },
      }),
    );

    return ok({
      provisioned: true,
      deviceId: device.deviceId,
      name: device.name,
      assignedIp: device.assignedIp,
      enabled: device.enabled,
      config: nodes[0]?.wgConfig ?? "",
      nodes,
      provisionToken: device.provisionToken,
    });
  } catch (err) {
    return handleError(err);
  }
}
