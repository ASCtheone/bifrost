import type { APIGatewayProxyResultV2 } from "aws-lambda";
import { HttpError } from "./auth.js";

export function ok(body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function error(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: message }),
  };
}

export function handleError(err: unknown): APIGatewayProxyResultV2 {
  if (err instanceof HttpError) {
    return error(err.statusCode, err.message);
  }

  const dynError = err as { name?: string; message?: string };
  if (dynError.name === "ConditionalCheckFailedException") {
    return error(409, "Conflict: condition check failed");
  }

  console.error("Unhandled error:", err);
  return error(500, "Internal server error");
}
