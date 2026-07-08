import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { UniFiBridge } from "../unifi-bridge.js";
import {
  handlePeerCreate,
  handlePeerList,
  handlePeerGet,
  handlePeerUpdate,
  handlePeerDelete,
} from "./peer-routes.js";
import { handlePeerConfigDownload } from "./config-routes.js";
import { handleSseStream, getActiveConnectionCount } from "./sse.js";
import { sendError, sendJson } from "./auth-middleware.js";

export function startApiServer(
  port: number,
  nodeId: string,
  bridge: UniFiBridge,
): void {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse) => {
      route(req, res, nodeId, bridge).catch((error) => {
        console.error("[api] unhandled error:", error);
        sendError(res, 500, "Internal server error");
      });
    },
  );

  server.listen(port, () => {
    console.log(`[api] Node API server listening on port ${port}`);
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  nodeId: string,
  bridge: UniFiBridge,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Health check (no auth required)
  if (path === "/health" && method === "GET") {
    return sendJson(res, 200, {
      status: "ok",
      nodeId,
      activeConnections: getActiveConnectionCount(),
    });
  }

  // SSE config stream
  if (path === "/config/stream" && method === "GET") {
    return handleSseStream(req, res);
  }

  // Peer CRUD
  if (path === "/peers" && method === "POST") {
    return handlePeerCreate(req, res, nodeId, bridge);
  }

  if (path === "/peers" && method === "GET") {
    return handlePeerList(req, res);
  }

  const peerMatch = path.match(/^\/peers\/([a-zA-Z0-9_-]+)$/);
  if (peerMatch) {
    const peerId = peerMatch[1]!;

    if (method === "GET") return handlePeerGet(req, res, peerId);
    if (method === "PUT") return handlePeerUpdate(req, res, peerId, bridge);
    if (method === "DELETE") return handlePeerDelete(req, res, peerId, bridge);
  }

  // Peer config download
  const configMatch = path.match(/^\/peers\/([a-zA-Z0-9_-]+)\/config$/);
  if (configMatch && method === "GET") {
    return handlePeerConfigDownload(req, res, configMatch[1]!, bridge);
  }

  sendError(res, 404, "Not found");
}
