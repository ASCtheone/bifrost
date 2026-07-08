import { randomBytes, createHash, generateKeyPairSync } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { DeviceType, ProvisionMethod } from "@bifrost/dynamo-schema";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { putDevice, queryAllNodes, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

function generateDeviceId(): string {
  return `dev-${randomBytes(4).toString("hex")}`;
}

function generateProvisionToken(): string {
  return randomBytes(24).toString("base64url");
}

function generateWgKeypair(): { privateKey: string; publicKey: string } {
  const kp = generateKeyPairSync("x25519");
  const privateKey = kp.privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
  const publicKey = kp.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64");
  return { privateKey, publicKey };
}

function generatePresharedKey(): string {
  return randomBytes(32).toString("base64");
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

    const body = JSON.parse(event.body ?? "{}") as {
      name?: string;
      type?: DeviceType;
      nodeId?: string;
      provisionMethod?: ProvisionMethod;
    };

    if (!body.name) throw new HttpError(400, "Device name is required");

    const deviceType = body.type ?? "laptop";
    const provisionMethod = body.provisionMethod ?? "qrcode";
    const isSuperadmin = auth.groups.includes("superadmin");
    const isAdmin = auth.groups.includes("admin");

    // Determine whose sparks to use:
    // - Own sparks + shared sparks
    let sparkOwnerEmail = auth.email;
    if (!isSuperadmin && !isAdmin) {
      const owner = await getUserOwner(auth.email);
      if (owner) sparkOwnerEmail = owner;
    }

    // Get shared sparks
    const sharedResult = await getDocClient().send(
      new ScanCommand({
        TableName: getTableName(),
        FilterExpression: "entityType = :et AND sharedWithEmail = :email",
        ExpressionAttributeValues: { ":et": "SparkShare", ":email": sparkOwnerEmail },
      }),
    );
    const sharedNodeIds = new Set((sharedResult.Items ?? []).map((i) => i["nodeId"] as string));

    // Find sparks: owned + shared
    const allNodes = await queryAllNodes();
    const ownerNodes = allNodes.filter((n) => {
      const nodeOwner = (n as unknown as { ownerEmail?: string }).ownerEmail;
      const isOwned = n.adoptionStatus === "adopted" && nodeOwner === sparkOwnerEmail;
      const isShared = n.adoptionStatus === "adopted" && sharedNodeIds.has(n.nodeId);
      return isOwned || isShared;
    });

    let nodeId = body.nodeId;
    if (!nodeId) {
      const adopted = ownerNodes[0];
      if (!adopted) throw new HttpError(400, "No sparks available for your account");
      nodeId = adopted.nodeId;
    }

    const { getNode } = await import("@bifrost/dynamo-repo");
    const node = await getNode(nodeId);
    if (!node) throw new HttpError(404, "Spark not found");

    const sparkServer = node.actualConfig?.servers?.find(
      (s) => s.name === node.sparkVpnName,
    );

    const deviceId = generateDeviceId();
    const { privateKey, publicKey } = generateWgKeypair();
    const presharedKey = generatePresharedKey();
    const provisionToken = generateProvisionToken();
    const now = new Date().toISOString();

    const serverAddress = sparkServer?.serverAddress ?? "192.168.8.1/24";
    const subnetBase = serverAddress.split("/")[0]!.split(".").slice(0, 3).join(".");
    const hash = createHash("md5").update(deviceId).digest();
    const octet4 = (hash[0]! % 250) + 2;
    const assignedIp = `${subnetBase}.${octet4}`;

    const device = await putDevice({
      deviceId,
      nodeId,
      name: body.name,
      type: deviceType,
      status: "pending",
      provisionMethod,
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

    return ok({
      device: {
        id: device.deviceId,
        name: device.name,
        type: device.type,
        assignedIp: device.assignedIp,
        provisionToken: device.provisionToken,
        provisionMethod: device.provisionMethod,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
