import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminEnableUserCommand,
  AdminDisableUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminResetUserPasswordCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { requireAdmin, getAuthContext, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

const cognito = new CognitoIdentityProviderClient({});

function mapCognitoError(err: unknown): HttpError {
  const e = err as { name?: string; message?: string };
  switch (e.name) {
    case "UserNotFoundException": return new HttpError(404, "User not found");
    case "NotAuthorizedException": return new HttpError(403, "Not authorized");
    case "TooManyRequestsException": return new HttpError(429, "Too many requests");
    case "InvalidParameterException": return new HttpError(400, e.message ?? "Invalid parameters");
    default: return new HttpError(500, e.message ?? "Cognito error");
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const username = event.pathParameters?.["username"];
    if (!username) throw new HttpError(400, "Missing username");

    const body = JSON.parse(event.body ?? "{}") as {
      enabled?: boolean;
      isAdmin?: boolean;
      isSuperadmin?: boolean;
      resetPassword?: boolean;
    };

    const auth = getAuthContext(event);

    if (body.isAdmin !== undefined && !auth.groups.includes("superadmin")) {
      throw new HttpError(403, "Only superadmins can modify admin status");
    }
    if (body.isSuperadmin !== undefined && !auth.groups.includes("superadmin")) {
      throw new HttpError(403, "Only superadmins can modify superadmin status");
    }

    const userPoolId = process.env["COGNITO_USER_POOL_ID"];
    if (!userPoolId) throw new HttpError(500, "User pool not configured");

    const results: string[] = [];

    try {
      if (body.enabled === true) {
        await cognito.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username }));
        results.push("enabled");
      } else if (body.enabled === false) {
        await cognito.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }));
        results.push("disabled");
      }

      if (body.isAdmin === true) {
        await cognito.send(
          new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: "admin" }),
        );
        results.push("admin granted");
      } else if (body.isAdmin === false) {
        try {
          await cognito.send(
            new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: "admin" }),
          );
          results.push("admin revoked");
        } catch { /* might not be in group */ }
      }

      if (body.isSuperadmin === true) {
        await cognito.send(
          new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: "superadmin" }),
        );
        // Also ensure admin
        try {
          await cognito.send(
            new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: "admin" }),
          );
        } catch { /* already in group */ }
        results.push("superadmin granted");
      } else if (body.isSuperadmin === false) {
        try {
          await cognito.send(
            new AdminRemoveUserFromGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: "superadmin" }),
          );
          results.push("superadmin revoked");
        } catch { /* might not be in group */ }
      }

      if (body.resetPassword) {
        await cognito.send(
          new AdminResetUserPasswordCommand({ UserPoolId: userPoolId, Username: username }),
        );
        results.push("password reset sent");
      }
    } catch (err) {
      throw mapCognitoError(err);
    }

    return ok({ success: true, actions: results });
  } catch (err) {
    return handleError(err);
  }
}
