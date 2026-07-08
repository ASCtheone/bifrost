import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { requireAdmin, HttpError } from "../middleware/auth.js";
import { ok, handleError } from "../middleware/response.js";

const cognito = new CognitoIdentityProviderClient({});

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  try {
    requireAdmin(event);

    const username = event.pathParameters?.["username"];
    if (!username) throw new HttpError(400, "Missing username");

    const userPoolId = process.env["COGNITO_USER_POOL_ID"];
    if (!userPoolId) throw new HttpError(500, "User pool not configured");

    try {
      await cognito.send(
        new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }),
      );
    } catch (err) {
      const e = err as { name?: string; message?: string };
      if (e.name === "UserNotFoundException") throw new HttpError(404, "User not found");
      throw new HttpError(500, e.message ?? "Failed to delete user");
    }

    return ok({ success: true });
  } catch (err) {
    return handleError(err);
  }
}
