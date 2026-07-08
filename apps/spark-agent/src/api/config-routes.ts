import type { IncomingMessage, ServerResponse } from "node:http";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { peerKey } from "@bifrost/dynamo-schema";
import type { PeerEntity } from "@bifrost/dynamo-schema";
import { generatePeerConfig } from "@bifrost/unifi-connect";
import type { UniFiBridge } from "../unifi-bridge.js";
import {
  verifyAuthToken,
  sendUnauthorized,
  sendError,
} from "./auth-middleware.js";
import { getDocClient } from "../aws-client.js";

function getTableName(): string {
  return process.env["TABLE_NAME"]!;
}

export async function handlePeerConfigDownload(
  req: IncomingMessage,
  res: ServerResponse,
  peerId: string,
  bridge: UniFiBridge,
): Promise<void> {
  const uid = await verifyAuthToken(req);
  if (!uid) return sendUnauthorized(res);

  // Read peer from DynamoDB
  const peerResult = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: peerKey(peerId),
    }),
  );

  if (!peerResult.Item) {
    return sendError(res, 404, "Peer not found");
  }

  const peer = peerResult.Item as unknown as PeerEntity;

  if (!peer.unifiPeerId) {
    return sendError(res, 400, "Peer has no UniFi peer ID — not yet provisioned");
  }

  // Read the full peer from UniFi (includes private_key if available)
  let unifiPeer;
  try {
    unifiPeer = await bridge.getPeer(peer.unifiPeerId);
  } catch {
    return sendError(res, 404, "Peer not found on UniFi controller");
  }

  if (!unifiPeer.private_key && !peer.privateKeyEncrypted) {
    return sendError(
      res,
      400,
      "Private key not available — it is only returned at peer creation time",
    );
  }

  // Read the WireGuard server from UniFi
  let server;
  try {
    server = await bridge.getServer(peer.serverId);
  } catch {
    return sendError(res, 404, "WireGuard server not found on UniFi controller");
  }

  const peerForConfig = unifiPeer.private_key
    ? unifiPeer
    : { ...unifiPeer, private_key: peer.privateKeyEncrypted };

  try {
    const configText = generatePeerConfig(server, peerForConfig);

    const filename = `${peer.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.conf`;

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    res.end(configText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 500, `Config generation failed: ${message}`);
  }
}
