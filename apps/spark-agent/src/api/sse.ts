import type { IncomingMessage, ServerResponse } from "node:http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { peerKey, vpnConfigKey } from "@bifrost/dynamo-schema";
import { verifyAuthToken, sendUnauthorized, sendError } from "./auth-middleware.js";
import { getDocClient } from "../aws-client.js";

function getTableName(): string {
  return process.env["TABLE_NAME"]!;
}

const activeConnections = new Map<string, Set<ServerResponse>>();

export async function handleSseStream(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const peerId = url.searchParams.get("peerId");

  if (!peerId) {
    return sendError(res, 400, "peerId query parameter is required");
  }

  // Verify peer exists
  const peerResult = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  if (!peerResult.Item) {
    return sendError(res, 404, "Peer not found");
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial config
  const initialData = { id: peerId, ...peerResult.Item };
  res.write(`event: config\ndata: ${JSON.stringify(initialData)}\n\n`);

  // Track this connection
  if (!activeConnections.has(peerId)) {
    activeConnections.set(peerId, new Set());
  }
  activeConnections.get(peerId)!.add(res);

  // Poll for changes every 5s (replacing Firestore onSnapshot)
  let lastPeerVersion = peerResult.Item["configVersion"] as number ?? 0;
  let lastVpnVersion = 0;

  // Get initial vpn config version
  const vpnResult = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: vpnConfigKey(),
    }),
  );
  if (vpnResult.Item) {
    lastVpnVersion = vpnResult.Item["configVersion"] as number ?? 0;
    res.write(`event: vpnConfig\ndata: ${JSON.stringify(vpnResult.Item)}\n\n`);
  }

  const pollInterval = setInterval(async () => {
    try {
      // Check peer changes
      const peerCheck = await getDocClient().send(
        new GetCommand({
          TableName: getTableName(),
          Key: peerKey(peerId),
        }),
      );

      if (!peerCheck.Item) {
        res.write(`event: deleted\ndata: {"peerId":"${peerId}"}\n\n`);
        return;
      }

      const peerVersion = peerCheck.Item["configVersion"] as number ?? 0;
      if (peerVersion !== lastPeerVersion) {
        lastPeerVersion = peerVersion;
        const data = { id: peerId, ...peerCheck.Item };
        res.write(`event: config\ndata: ${JSON.stringify(data)}\n\n`);
      }

      // Check vpn config changes
      const vpnCheck = await getDocClient().send(
        new GetCommand({
          TableName: getTableName(),
          Key: vpnConfigKey(),
        }),
      );

      if (vpnCheck.Item) {
        const vpnVersion = vpnCheck.Item["configVersion"] as number ?? 0;
        if (vpnVersion !== lastVpnVersion) {
          lastVpnVersion = vpnVersion;
          res.write(`event: vpnConfig\ndata: ${JSON.stringify(vpnCheck.Item)}\n\n`);
        }
      }
    } catch (err) {
      console.error(`[sse] poll error for peer ${peerId}:`, err);
    }
  }, 5000);

  // Keep-alive ping every 30s
  const pingInterval = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  // Cleanup on disconnect
  req.on("close", () => {
    clearInterval(pollInterval);
    clearInterval(pingInterval);
    activeConnections.get(peerId)?.delete(res);
    if (activeConnections.get(peerId)?.size === 0) {
      activeConnections.delete(peerId);
    }
    console.log(`[sse] Client disconnected for peer ${peerId}`);
  });
}

export function getActiveConnectionCount(): number {
  let count = 0;
  for (const conns of activeConnections.values()) {
    count += conns.size;
  }
  return count;
}
