import { createHash, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyEventV2 } from "aws-lambda";
import { getNodeByAdoptionCode, getNode } from "@bifrost/dynamo-repo";

// ── Types ───────────────────────────────────────────────────────

export interface AuthContext {
  readonly sub: string;
  readonly email: string;
  readonly groups: readonly string[];
}

export interface AdoptionCodeContext {
  readonly nodeId: string;
  readonly adoptionCode: string;
}

export interface NodeKeyContext {
  readonly nodeId: string;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

// ── JWT Auth (Admin Dashboard) ──────────────────────────────────

export function getAuthContext(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): AuthContext {
  let claims = event.requestContext?.authorizer?.jwt?.claims;

  // SST dev mode: JWT authorizer doesn't forward claims — decode from Authorization header
  if (!claims && process.env["SST_STAGE"] && process.env["SST_STAGE"] !== "production") {
    const authHeader = event.headers?.["authorization"] ?? event.headers?.["Authorization"] ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (token) {
      try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64").toString());
        claims = payload;
      } catch {
        // Fall through
      }
    }
    if (!claims) {
      return { sub: "dev", email: "dev@local", groups: ["admin"] };
    }
  }

  if (!claims) {
    throw new HttpError(401, "Missing authorization claims");
  }

  const sub = (claims["sub"] as string) ?? "";
  const email = (claims["email"] as string)
    ?? (claims["username"] as string)
    ?? (claims["preferred_username"] as string)
    ?? "";
  console.log("[auth] claims keys:", Object.keys(claims), "email:", email, "sub:", sub);
  const groupsClaim = claims["cognito:groups"];
  const groups: readonly string[] = Array.isArray(groupsClaim)
    ? groupsClaim
    : typeof groupsClaim === "string"
      ? groupsClaim.split(",")
      : [];

  return { sub, email, groups };
}

export function requireAdmin(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): AuthContext {
  const auth = getAuthContext(event);
  if (!auth.groups.includes("admin")) {
    throw new HttpError(403, "Admin role required");
  }
  return auth;
}

// ── Adoption Code Auth (Spark during bootstrap) ─────────────────

export async function validateAdoptionCode(
  event: APIGatewayProxyEventV2,
): Promise<AdoptionCodeContext> {
  // Code can be in body (POST) or query string (GET)
  let code: string | undefined;

  if (event.queryStringParameters?.["code"]) {
    code = event.queryStringParameters["code"];
  } else if (event.body) {
    const body = JSON.parse(event.body) as Record<string, unknown>;
    code = body["adoptionCode"] as string | undefined;
  }

  if (!code) {
    throw new HttpError(400, "Missing adoption code");
  }

  console.log("[auth] Looking up adoption code:", code);
  const node = await getNodeByAdoptionCode(code);
  console.log("[auth] Found node:", node?.nodeId ?? "null");
  if (!node) {
    throw new HttpError(404, "Invalid adoption code");
  }

  if (node.codeExpiresAt && new Date(node.codeExpiresAt) < new Date()) {
    throw new HttpError(410, "Adoption code has expired");
  }

  return { nodeId: node.nodeId, adoptionCode: code };
}

// ── Node Key Auth (Spark during normal operation) ───────────────

export async function validateNodeKey(
  event: APIGatewayProxyEventV2,
): Promise<NodeKeyContext> {
  const key = event.headers?.["x-node-key"];
  if (!key) {
    throw new HttpError(401, "Missing X-Node-Key header");
  }

  const nodeId = event.pathParameters?.["nodeId"]
    ?? (event.queryStringParameters?.["nodeId"] as string | undefined);
  if (!nodeId) {
    throw new HttpError(400, "Missing nodeId");
  }

  const node = await getNode(nodeId);
  if (!node || !node.nodeKeyHash) {
    throw new HttpError(401, "Invalid node key");
  }

  if (node.adoptionStatus === "revoked") {
    throw new HttpError(401, "Node key has been revoked");
  }

  const incomingHash = createHash("sha256").update(key).digest();
  const storedHash = Buffer.from(node.nodeKeyHash, "hex");

  if (incomingHash.length !== storedHash.length || !timingSafeEqual(incomingHash, storedHash)) {
    throw new HttpError(401, "Invalid node key");
  }

  return { nodeId };
}
