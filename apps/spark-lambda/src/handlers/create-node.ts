import { randomBytes } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { putNodeIfNotExists } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

function generateNodeId(): string {
  return `node-${randomBytes(3).toString("hex")}`;
}

function generateAdoptionCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/1/I
  const bytes = randomBytes(9);
  const code = Array.from(bytes).map((b) => chars[b % chars.length]).join("");
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);

    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const nodeName = (body["name"] as string) || generateNodeId();
    const nodeId = generateNodeId();
    const adoptionCode = generateAdoptionCode();
    const now = new Date().toISOString();
    const codeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await putNodeIfNotExists({
      nodeId,
      nodeName,
      ownerId: auth.sub,
      ownerEmail: auth.email,
      status: "offline",
      role: "secondary",
      priority: 100,
      lastSeen: now,
      tunnelUrl: "",
      tunnelId: "",
      controllerUrl: "",
      controllerApiKey: null,
      sparkVpnName: null,
      sparkVpnId: null,
      pendingVpnCreate: false,
      syncState: "synced",
      lastAppliedVersion: 0,
      actualConfig: null,
      error: null,
      adoptionStatus: "pending",
      adoptionCode,
      codeExpiresAt,
      nodeKeyHash: null,
      keyIssuedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    return ok({ nodeId, nodeName, adoptionCode });
  } catch (err) {
    return handleError(err);
  }
}
