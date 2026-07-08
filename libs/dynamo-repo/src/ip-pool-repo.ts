import { GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { IpPoolEntity } from "@bifrost/dynamo-schema";
import { ipPoolKey, fromIpPoolItem, toIpPoolItem } from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

const MAX_RETRIES = 5;

export async function getIpPool(
  subnetKey: string,
): Promise<IpPoolEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: ipPoolKey(subnetKey),
    }),
  );
  return result.Item ? fromIpPoolItem(result.Item) : undefined;
}

export async function createIpPool(
  subnetKey: string,
  subnet: string,
  gateway: string,
  totalAddresses: number,
): Promise<IpPoolEntity> {
  const item = toIpPoolItem({
    subnetKey,
    subnet,
    gateway,
    allocated: {},
    nextAvailable: 2, // .1 is gateway
    totalAddresses,
  });
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
      ConditionExpression: "attribute_not_exists(PK)",
    }),
  );
  return item;
}

export async function allocateIp(
  subnetKey: string,
  peerId: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const pool = await getIpPool(subnetKey);
    if (!pool) {
      throw new Error(`IP pool ${subnetKey} not found`);
    }

    if (pool.nextAvailable >= pool.totalAddresses) {
      throw new Error(`IP pool ${subnetKey} exhausted`);
    }

    // Check if peer already has an allocation
    const existing = pool.allocated[peerId];
    if (existing) {
      return existing;
    }

    const subnetBase = pool.subnet.split("/")[0]!;
    const octets = subnetBase.split(".");
    const baseIp = octets.slice(0, 3).join(".");
    const ip = `${baseIp}.${pool.nextAvailable}`;

    try {
      await getDocClient().send(
        new UpdateCommand({
          TableName: getTableName(),
          Key: ipPoolKey(subnetKey),
          UpdateExpression:
            "SET #alloc.#peer = :ip, #next = :nextVal",
          ExpressionAttributeNames: {
            "#alloc": "allocated",
            "#peer": peerId,
            "#next": "nextAvailable",
          },
          ExpressionAttributeValues: {
            ":ip": ip,
            ":nextVal": pool.nextAvailable + 1,
            ":expected": pool.nextAvailable,
          },
          ConditionExpression:
            "attribute_exists(PK) AND #next = :expected AND attribute_not_exists(#alloc.#peer)",
        }),
      );
      return ip;
    } catch (err: unknown) {
      const error = err as { name?: string };
      if (error.name === "ConditionalCheckFailedException") {
        continue; // retry
      }
      throw err;
    }
  }
  throw new Error(`Failed to allocate IP after ${MAX_RETRIES} retries`);
}

export async function releaseIp(
  subnetKey: string,
  peerId: string,
): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: ipPoolKey(subnetKey),
      UpdateExpression: "REMOVE #alloc.#peer",
      ExpressionAttributeNames: {
        "#alloc": "allocated",
        "#peer": peerId,
      },
      ConditionExpression: "attribute_exists(PK)",
    }),
  );
}
