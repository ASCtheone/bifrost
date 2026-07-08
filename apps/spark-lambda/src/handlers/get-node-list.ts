import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { queryAllNodes, getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

async function getSharedNodeIds(email: string): Promise<Set<string>> {
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "entityType = :et AND sharedWithEmail = :email",
      ExpressionAttributeValues: { ":et": "SparkShare", ":email": email },
    }),
  );
  return new Set((result.Items ?? []).map((i) => i["nodeId"] as string));
}

async function getUserOwnerEmail(email: string): Promise<string | null> {
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
    const showAll = event.queryStringParameters?.["all"] === "true";
    const isSuperadmin = auth.groups.includes("superadmin");
    const isAdmin = auth.groups.includes("admin");

    const allNodes = await queryAllNodes();

    // Get shares for this user + their owner (if regular user)
    const sharedWithMe = await getSharedNodeIds(auth.email);
    let sharedWithOwner = new Set<string>();
    if (!isAdmin && !isSuperadmin) {
      const ownerEmail = await getUserOwnerEmail(auth.email);
      if (ownerEmail) {
        sharedWithOwner = await getSharedNodeIds(ownerEmail);
      }
    }

    const filtered = (showAll && isSuperadmin)
      ? allNodes
      : allNodes.filter((n) => {
          const ownerId = (n as unknown as { ownerId?: string }).ownerId;
          const ownerEmail = (n as unknown as { ownerEmail?: string }).ownerEmail;
          // Own nodes
          if (!ownerId || ownerId === auth.sub || ownerEmail === auth.email) return true;
          // Shared with me or my owner
          if (sharedWithMe.has(n.nodeId)) return true;
          if (sharedWithOwner.has(n.nodeId)) return true;
          return false;
        });

    const result = filtered.map((node) => {
      const ownerEmail = (node as unknown as { ownerEmail?: string }).ownerEmail ?? null;
      const isOwned = !ownerEmail || ownerEmail === auth.email;
      const isShared = sharedWithMe.has(node.nodeId) || sharedWithOwner.has(node.nodeId);

      return {
        id: node.nodeId,
        name: node.nodeName ?? node.nodeId,
        tunnelUrl: node.tunnelUrl ?? "",
        tunnelId: node.tunnelId ?? "",
        controllerUrl: node.controllerUrl ?? "",
        hasControllerApiKey: !!node.controllerApiKey,
        sparkVpnName: node.sparkVpnName ?? null,
        sparkVpnId: node.sparkVpnId ?? null,
        pendingVpnCreate: node.pendingVpnCreate ?? false,
        role: node.role,
        priority: node.priority ?? 100,
        status: node.status,
        adoptionStatus: node.adoptionStatus ?? "adopted",
        adoptionCode: node.adoptionCode ?? null,
        syncState: node.syncState ?? "synced",
        lastAppliedVersion: node.lastAppliedVersion ?? 0,
        wanIp: (node as unknown as { wanIp?: string }).wanIp ?? null,
        geo: (node as unknown as { geo?: { city?: string; country?: string; region?: string } }).geo ?? null,
        ispName: (node as unknown as { ispName?: string }).ispName ?? null,
        speedDown: (node as unknown as { speedDown?: number }).speedDown ?? null,
        speedUp: (node as unknown as { speedUp?: number }).speedUp ?? null,
        error: node.error ?? null,
        actualConfig: node.actualConfig ?? null,
        lastSeen: node.lastSeen,
        createdAt: node.createdAt,
        ownerId: (node as unknown as { ownerId?: string }).ownerId ?? null,
        ownerEmail,
        shared: isShared && !isOwned,
      };
    });

    return ok({ nodes: result });
  } catch (err) {
    return handleError(err);
  }
}
