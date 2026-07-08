import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getDocClient, getTableName } from "@bifrost/dynamo-repo";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

const cognito = new CognitoIdentityProviderClient({});

function mapCognitoError(err: unknown): HttpError {
  const e = err as { name?: string; message?: string };
  switch (e.name) {
    case "InvalidPasswordException":
      return new HttpError(400, "Password must be 12+ characters with uppercase, lowercase, and numbers");
    case "UsernameExistsException":
      return new HttpError(409, "A user with this email already exists");
    case "InvalidParameterException":
      return new HttpError(400, e.message ?? "Invalid parameters");
    case "TooManyRequestsException":
      return new HttpError(429, "Too many requests, try again later");
    default:
      return new HttpError(500, e.message ?? "Cognito error");
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    const auth = requireAdmin(event);

    const body = JSON.parse(event.body ?? "{}") as {
      email?: string;
      username?: string;
      temporaryPassword?: string;
      isAdmin?: boolean;
      isSuperadmin?: boolean;
      ownerEmail?: string;
    };

    if (!body.email) throw new HttpError(400, "Email is required");

    // Only superadmins can grant admin or superadmin
    if (body.isAdmin && !auth.groups.includes("superadmin")) {
      throw new HttpError(403, "Only superadmins can grant admin role");
    }
    if (body.isSuperadmin && !auth.groups.includes("superadmin")) {
      throw new HttpError(403, "Only superadmins can create superadmin users");
    }

    const userPoolId = process.env["COGNITO_USER_POOL_ID"];
    if (!userPoolId) throw new HttpError(500, "User pool not configured");

    if (body.temporaryPassword) {
      const pw = body.temporaryPassword;
      const issues: string[] = [];
      if (pw.length < 12) issues.push("at least 12 characters");
      if (!/[A-Z]/.test(pw)) issues.push("an uppercase letter");
      if (!/[a-z]/.test(pw)) issues.push("a lowercase letter");
      if (!/[0-9]/.test(pw)) issues.push("a number");
      if (issues.length > 0) {
        throw new HttpError(400, `Password needs ${issues.join(", ")}`);
      }
    }

    // Use username as the Cognito username, email + preferred_username as aliases
    const cognitoUsername = body.username || body.email.split("@")[0]!;
    const userAttributes = [
      { Name: "email", Value: body.email },
      { Name: "email_verified", Value: "true" },
      { Name: "preferred_username", Value: cognitoUsername },
    ];

    let result;
    try {
      result = await cognito.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: cognitoUsername,
          TemporaryPassword: body.temporaryPassword || undefined,
          UserAttributes: userAttributes,
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
    } catch (err) {
      throw mapCognitoError(err);
    }

    try {
      if (body.isAdmin || body.isSuperadmin) {
        await cognito.send(
          new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: cognitoUsername, GroupName: "admin" }),
        );
      }
      if (body.isSuperadmin) {
        await cognito.send(
          new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: cognitoUsername, GroupName: "superadmin" }),
        );
      }
    } catch (err) {
      throw mapCognitoError(err);
    }

    // Store ownership record — superadmins can assign to another admin
    const effectiveOwner = (body.ownerEmail && auth.groups.includes("superadmin"))
      ? body.ownerEmail
      : auth.email;

    await getDocClient().send(
      new PutCommand({
        TableName: getTableName(),
        Item: {
          PK: `USER_OWNER#${body.email}`,
          SK: `USER_OWNER#${body.email}`,
          entityType: "UserOwnership",
          userEmail: body.email,
          ownerEmail: effectiveOwner,
          createdAt: new Date().toISOString(),
        },
      }),
    );

    return ok({
      username: result.User?.Username,
      email: body.email,
      displayName: body.username ?? body.email,
      status: result.User?.UserStatus,
    });
  } catch (err) {
    return handleError(err);
  }
}
