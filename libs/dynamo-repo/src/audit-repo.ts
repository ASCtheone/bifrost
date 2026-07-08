import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { AuditAction } from "@bifrost/dynamo-schema";
import { toAuditLogItem } from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

let ulidCounter = 0;

function generateUlid(): string {
  const now = Date.now();
  const time = now.toString(36).padStart(10, "0");
  const rand = Math.random().toString(36).slice(2, 12).padStart(10, "0");
  const seq = (ulidCounter++).toString(36).padStart(4, "0");
  return `${time}${seq}${rand}`.toUpperCase();
}

export async function writeAuditLog(
  action: AuditAction,
  actor: string,
  targetId: string,
  details: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  const now = new Date().toISOString();
  const item = toAuditLogItem({
    action,
    actor,
    targetId,
    details,
    timestamp: now,
    ulid: generateUlid(),
  });

  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
}
