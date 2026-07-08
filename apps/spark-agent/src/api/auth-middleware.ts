import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { IncomingMessage, ServerResponse } from "node:http";

let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier(): ReturnType<typeof CognitoJwtVerifier.create> {
  if (!verifier) {
    const userPoolId = process.env["COGNITO_USER_POOL_ID"];
    const clientId = process.env["COGNITO_CLIENT_ID"];
    if (!userPoolId || !clientId) {
      throw new Error("COGNITO_USER_POOL_ID and COGNITO_CLIENT_ID are required");
    }
    verifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: "access",
    });
  }
  return verifier;
}

export async function verifyAuthToken(
  req: IncomingMessage,
): Promise<string | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);

  try {
    const payload = await getVerifier().verify(token);
    const groups = (payload["cognito:groups"] as string[] | undefined) ?? [];

    if (!groups.includes("admin")) {
      return null;
    }

    return payload.sub;
  } catch {
    return null;
  }
}

export function sendUnauthorized(res: ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}
