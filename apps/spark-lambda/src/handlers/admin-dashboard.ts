import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { queryAllNodes, queryAllDevices } from "@bifrost/dynamo-repo";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { requireAdmin } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

const cognito = new CognitoIdentityProviderClient({});

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const isSuperadmin = auth.groups.includes("superadmin");
    if (!isSuperadmin) {
      return ok({ authorized: false });
    }

    const section = event.queryStringParameters?.["section"];

    if (section === "sparks") {
      const nodes = await queryAllNodes();
      return ok({
        authorized: true,
        sparks: nodes.map((n) => ({
          id: n.nodeId,
          name: n.nodeName ?? n.nodeId,
          status: n.status,
          role: n.role,
          adoptionStatus: n.adoptionStatus ?? "adopted",
          wanIp: (n as unknown as { wanIp?: string }).wanIp ?? null,
          geo: (n as unknown as { geo?: { city?: string; country?: string } }).geo ?? null,
          ispName: (n as unknown as { ispName?: string }).ispName ?? null,
          speedDown: (n as unknown as { speedDown?: number }).speedDown ?? null,
          speedUp: (n as unknown as { speedUp?: number }).speedUp ?? null,
          ownerEmail: (n as unknown as { ownerEmail?: string }).ownerEmail ?? null,
          lastSeen: n.lastSeen,
        })),
      });
    }

    if (section === "devices") {
      const devices = await queryAllDevices();
      return ok({
        authorized: true,
        devices: devices.map((d) => ({
          id: d.deviceId,
          name: d.name,
          type: d.type,
          status: d.status,
          assignedIp: d.assignedIp,
          enabled: d.enabled,
          ownerEmail: (d as unknown as { ownerEmail?: string }).ownerEmail ?? null,
        })),
      });
    }

    if (section === "users") {
      const userPoolId = process.env["COGNITO_USER_POOL_ID"];
      if (!userPoolId) return ok({ authorized: true, users: [] });

      const result = await cognito.send(new ListUsersCommand({ UserPoolId: userPoolId }));
      const users = await Promise.all(
        (result.Users ?? []).map(async (u) => {
          const email = u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username ?? "";
          const displayName = u.Attributes?.find((a) => a.Name === "preferred_username")?.Value ?? "";
          let groups: string[] = [];
          try {
            const gr = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: u.Username! }));
            groups = (gr.Groups ?? []).map((g) => g.GroupName!).filter(Boolean);
          } catch { /* ignore */ }
          return {
            username: u.Username,
            displayName,
            email,
            enabled: u.Enabled ?? true,
            groups,
            status: u.UserStatus,
          };
        }),
      );
      return ok({ authorized: true, users });
    }

    // Summary
    const [nodes, devices] = await Promise.all([queryAllNodes(), queryAllDevices()]);
    return ok({
      authorized: true,
      role: "superadmin",
      email: auth.email,
      counts: {
        sparks: nodes.length,
        sparksOnline: nodes.filter((n) => n.status === "online").length,
        devices: devices.length,
      },
    });
  } catch (err) {
    return handleError(err);
  }
}
