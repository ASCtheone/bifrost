import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { requireAdmin } from "../middleware/auth.js";
import { getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { ok, handleError } from "../middleware/response.js";

const cognito = new CognitoIdentityProviderClient({});

async function getUserOwnershipMap(): Promise<Map<string, string>> {
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "entityType = :et",
      ExpressionAttributeValues: { ":et": "UserOwnership" },
    }),
  );
  const map = new Map<string, string>();
  for (const item of result.Items ?? []) {
    map.set(item["userEmail"] as string, item["ownerEmail"] as string);
  }
  return map;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);
    const isSuperadmin = auth.groups.includes("superadmin");

    const userPoolId = process.env["COGNITO_USER_POOL_ID"];
    if (!userPoolId) return ok({ users: [], callerIsSuperadmin: isSuperadmin });

    const [cognitoResult, ownershipMap] = await Promise.all([
      cognito.send(new ListUsersCommand({ UserPoolId: userPoolId })),
      getUserOwnershipMap(),
    ]);

    const allUsers = await Promise.all(
      (cognitoResult.Users ?? []).map(async (u) => {
        const email = u.Attributes?.find((a) => a.Name === "email")?.Value ?? u.Username ?? "";
        const sub = u.Attributes?.find((a) => a.Name === "sub")?.Value ?? "";
        const displayName = u.Attributes?.find((a) => a.Name === "preferred_username")?.Value ?? "";

        let groups: string[] = [];
        try {
          const gr = await cognito.send(
            new AdminListGroupsForUserCommand({
              UserPoolId: userPoolId,
              Username: u.Username!,
            }),
          );
          groups = (gr.Groups ?? []).map((g) => g.GroupName!).filter(Boolean);
        } catch { /* ignore */ }

        return {
          username: u.Username,
          displayName,
          email,
          sub,
          status: u.UserStatus,
          enabled: u.Enabled ?? true,
          groups,
          createdAt: u.UserCreateDate?.toISOString() ?? "",
          lastModified: u.UserLastModifiedDate?.toISOString() ?? "",
          createdBy: ownershipMap.get(email) ?? null,
        };
      }),
    );

    // Superadmins see all users, admins see only their own created users + themselves
    console.log("[list-users] caller email:", auth.email, "sub:", auth.sub, "groups:", auth.groups, "isSuperadmin:", isSuperadmin);
    console.log("[list-users] ownership map:", JSON.stringify(Object.fromEntries(ownershipMap)));
    console.log("[list-users] all users:", allUsers.map(u => ({ email: u.email, createdBy: u.createdBy })));

    const filtered = isSuperadmin
      ? allUsers
      : allUsers.filter((u) =>
          u.email === auth.email || u.createdBy === auth.email,
        );

    return ok({ users: filtered, callerIsSuperadmin: isSuperadmin });
  } catch (err) {
    return handleError(err);
  }
}
