import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { nodeKey, nodeStatusGsi2 } from "@bifrost/dynamo-schema";
import { getDocClient, getTableName, updateDeviceUnifiPeerId } from "@bifrost/dynamo-repo";
import { validateNodeKey } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const { nodeId } = await validateNodeKey(event);

    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const actualConfig = body["actualConfig"] ?? null;
    const wanIp = body["wanIp"] as string | undefined;
    const geo = body["geo"] as { city?: string; country?: string; region?: string } | undefined;
    const ispName = body["ispName"] as string | undefined;
    const speedDown = body["speedDown"] as number | undefined;
    const speedUp = body["speedUp"] as number | undefined;
    const speedPing = body["speedPing"] as number | undefined;
    const sparkVpnId = body["sparkVpnId"] as string | undefined;
    const pendingVpnCreate = body["pendingVpnCreate"] as boolean | undefined;
    const createdPeers = body["createdPeers"] as { deviceId: string; unifiPeerId: string }[] | undefined;
    const clearPeerDeletions = body["clearPeerDeletions"] as boolean | undefined;

    const now = new Date().toISOString();
    const gsi2 = nodeStatusGsi2("online", now, nodeId);

    const updates = [
      "#status = :online",
      "#lastSeen = :now",
      "#updatedAt = :now",
      "#GSI2PK = :gsi2pk",
      "#GSI2SK = :gsi2sk",
      "#actualConfig = :ac",
    ];
    const names: Record<string, string> = {
      "#status": "status",
      "#lastSeen": "lastSeen",
      "#updatedAt": "updatedAt",
      "#GSI2PK": "GSI2PK",
      "#GSI2SK": "GSI2SK",
      "#actualConfig": "actualConfig",
    };
    const values: Record<string, unknown> = {
      ":online": "online",
      ":now": now,
      ":gsi2pk": gsi2.GSI2PK,
      ":gsi2sk": gsi2.GSI2SK,
      ":ac": actualConfig,
    };

    if (wanIp) {
      updates.push("#wanIp = :wanIp");
      names["#wanIp"] = "wanIp";
      values[":wanIp"] = wanIp;
    }
    if (geo) {
      updates.push("#geo = :geo");
      names["#geo"] = "geo";
      values[":geo"] = geo;
    }
    if (ispName) {
      updates.push("#ispName = :ispName");
      names["#ispName"] = "ispName";
      values[":ispName"] = ispName;
    }
    if (speedDown !== undefined && speedDown !== null) {
      updates.push("#speedDown = :speedDown");
      names["#speedDown"] = "speedDown";
      values[":speedDown"] = speedDown;
    }
    if (speedUp !== undefined && speedUp !== null) {
      updates.push("#speedUp = :speedUp");
      names["#speedUp"] = "speedUp";
      values[":speedUp"] = speedUp;
    }
    if (speedPing !== undefined && speedPing !== null) {
      updates.push("#speedPing = :speedPing");
      names["#speedPing"] = "speedPing";
      values[":speedPing"] = speedPing;
    }
    if (clearPeerDeletions) {
      updates.push("#ppd = :emptyList");
      names["#ppd"] = "pendingPeerDeletions";
      values[":emptyList"] = [];
    }
    if (sparkVpnId !== undefined) {
      updates.push("#sparkVpnId = :svid");
      names["#sparkVpnId"] = "sparkVpnId";
      values[":svid"] = sparkVpnId;
    }
    if (pendingVpnCreate !== undefined) {
      updates.push("#pendingVpnCreate = :pvc");
      names["#pendingVpnCreate"] = "pendingVpnCreate";
      values[":pvc"] = pendingVpnCreate;
    }

    await getDocClient().send(
      new UpdateCommand({
        TableName: getTableName(),
        Key: nodeKey(nodeId),
        UpdateExpression: `SET ${updates.join(", ")}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );

    // Process created peers (device -> UniFi peer mapping)
    if (createdPeers?.length) {
      for (const { deviceId, unifiPeerId } of createdPeers) {
        try {
          await updateDeviceUnifiPeerId(deviceId, unifiPeerId);
        } catch (e) {
          console.error(`Failed to update device ${deviceId} peer:`, e);
        }
      }
    }

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
