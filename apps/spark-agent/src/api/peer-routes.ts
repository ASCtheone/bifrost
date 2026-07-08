import type { IncomingMessage, ServerResponse } from "node:http";
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { peerKey, vpnConfigKey, toPeerItem } from "@bifrost/dynamo-schema";
import type { PeerEntity } from "@bifrost/dynamo-schema";
import type { UniFiBridge } from "../unifi-bridge.js";
import {
  verifyAuthToken,
  sendUnauthorized,
  sendJson,
  sendError,
} from "./auth-middleware.js";
import { allocateIp, releaseIp } from "./ip-pool.js";
import { getDocClient } from "../aws-client.js";

function getTableName(): string {
  return process.env["TABLE_NAME"]!;
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function handlePeerCreate(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  bridge: UniFiBridge,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const body = await readBody(req);
  const { name, serverId, allowedIps } = body as {
    name?: string;
    serverId?: string;
    allowedIps?: string[];
  };

  if (!name || !serverId) {
    return sendError(res, 400, "name and serverId are required");
  }

  // Get VPN config for subnet info
  const configResult = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: vpnConfigKey(),
    }),
  );
  const config = configResult.Item;
  const server = config?.["server"] as Record<string, unknown> | undefined;
  const subnet = (server?.["address"] as string) ?? "10.0.0.0/24";
  const subnetKey = subnet.replace(/\//g, "_");

  const peerId = generateId();
  let assignedIp: string;

  try {
    assignedIp = await allocateIp(subnetKey, peerId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sendError(res, 500, `IP allocation failed: ${message}`);
  }

  // Create peer on UniFi controller
  let unifiPeer;
  try {
    unifiPeer = await bridge.createPeer({
      name,
      server_id: serverId,
      ip: assignedIp,
      allowed_ips: allowedIps ?? ["0.0.0.0/0", "::/0"],
      enabled: true,
    });
  } catch (error) {
    await releaseIp(subnetKey, assignedIp).catch((err) =>
      console.error("[peer-routes] Failed to release IP on rollback:", err),
    );
    const message = error instanceof Error ? error.message : String(error);
    return sendError(res, 502, `UniFi peer creation failed: ${message}`);
  }

  const now = new Date().toISOString();
  const item = toPeerItem({
    peerId,
    name,
    serverId,
    nodeId,
    unifiPeerId: unifiPeer._id,
    publicKey: unifiPeer.public_key,
    privateKeyEncrypted: unifiPeer.private_key ?? "",
    presharedKey: unifiPeer.preshared_key ?? "",
    assignedIp,
    allowedIps: allowedIps ?? ["0.0.0.0/0", "::/0"],
    endpoint: "",
    configVersion: 0,
    enabled: true,
    createdBy: uid,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: item as unknown as Record<string, unknown>,
      }),
    );
    sendJson(res, 201, { id: peerId, ...item });
  } catch (error) {
    await bridge.deletePeer(unifiPeer._id).catch((err) =>
      console.error("[peer-routes] Failed to delete UniFi peer on rollback:", err),
    );
    await releaseIp(subnetKey, assignedIp).catch((err) =>
      console.error("[peer-routes] Failed to release IP on rollback:", err),
    );
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, message);
  }
}

export async function handlePeerList(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const scanResult = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "begins_with(PK, :prefix)",
      ExpressionAttributeValues: {
        ":prefix": "PEER#",
      },
    }),
  );

  const peers = (scanResult.Items ?? []).map((item) => ({
    id: item["peerId"],
    ...item,
  }));

  sendJson(res, 200, { peers });
}

export async function handlePeerGet(
  req: IncomingMessage,
  res: ServerResponse,
  peerId: string,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  if (!result.Item) {
    return sendError(res, 404, "Peer not found");
  }

  sendJson(res, 200, { id: peerId, ...result.Item });
}

export async function handlePeerUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  peerId: string,
  bridge: UniFiBridge,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const body = await readBody(req);
  const { name, allowedIps, enabled } = body as {
    name?: string;
    allowedIps?: string[];
    enabled?: boolean;
  };

  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  if (!result.Item) {
    return sendError(res, 404, "Peer not found");
  }

  const data = result.Item as unknown as PeerEntity;
  const unifiPeerId = data.unifiPeerId;

  // Update on UniFi controller first
  if (unifiPeerId) {
    const unifiChanges: Record<string, unknown> = {};
    if (name !== undefined) unifiChanges["name"] = name;
    if (allowedIps !== undefined) unifiChanges["allowed_ips"] = allowedIps;
    if (enabled !== undefined) unifiChanges["enabled"] = enabled;

    if (Object.keys(unifiChanges).length > 0) {
      try {
        await bridge.updatePeer(unifiPeerId, unifiChanges);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return sendError(res, 502, `UniFi peer update failed: ${message}`);
      }
    }
  }

  // Update DynamoDB
  const expressions: string[] = ["#updatedAt = :now"];
  const names: Record<string, string> = { "#updatedAt": "updatedAt" };
  const values: Record<string, unknown> = { ":now": new Date().toISOString() };

  if (name !== undefined) {
    expressions.push("#name = :name");
    names["#name"] = "name";
    values[":name"] = name;
  }
  if (allowedIps !== undefined) {
    expressions.push("#allowedIps = :allowedIps");
    names["#allowedIps"] = "allowedIps";
    values[":allowedIps"] = allowedIps;
  }
  if (enabled !== undefined) {
    expressions.push("#enabled = :enabled");
    names["#enabled"] = "enabled";
    values[":enabled"] = enabled;
  }

  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
      UpdateExpression: `SET ${expressions.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );

  // Re-read updated item
  const updated = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  sendJson(res, 200, { id: peerId, ...updated.Item });
}

export async function handlePeerDelete(
  req: IncomingMessage,
  res: ServerResponse,
  peerId: string,
  bridge: UniFiBridge,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  if (!result.Item) {
    return sendError(res, 404, "Peer not found");
  }

  const data = result.Item as unknown as PeerEntity;
  const unifiPeerId = data.unifiPeerId;
  const assignedIp = data.assignedIp;

  // Delete from UniFi controller first
  if (unifiPeerId) {
    try {
      await bridge.deletePeer(unifiPeerId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(res, 502, `UniFi peer deletion failed: ${message}`);
    }
  }

  // Delete from DynamoDB
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  // Release IP back to pool
  if (assignedIp) {
    const configResult = await getDocClient().send(
      new GetCommand({
        TableName: getTableName(),
        Key: vpnConfigKey(),
      }),
    );
    const config = configResult.Item;
    const server = config?.["server"] as Record<string, unknown> | undefined;
    const subnet = (server?.["address"] as string) ?? "10.0.0.0/24";
    const subnetKey = subnet.replace(/\//g, "_");
    await releaseIp(subnetKey, assignedIp);
  }

  sendJson(res, 200, { deleted: true });
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString();
        resolve(text ? JSON.parse(text) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
