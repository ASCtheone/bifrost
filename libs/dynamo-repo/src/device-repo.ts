import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DeviceEntity } from "@bifrost/dynamo-schema";
import {
  deviceKey,
  fromDeviceItem,
  toDeviceItem,
  type DeviceInput,
} from "@bifrost/dynamo-schema";
import { getDocClient, getTableName } from "./client.js";

export async function getDevice(deviceId: string): Promise<DeviceEntity | undefined> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getTableName(),
      Key: deviceKey(deviceId),
    }),
  );
  return result.Item ? fromDeviceItem(result.Item) : undefined;
}

export async function putDevice(input: DeviceInput): Promise<DeviceEntity> {
  const item = toDeviceItem(input);
  await getDocClient().send(
    new PutCommand({
      TableName: getTableName(),
      Item: item as unknown as Record<string, unknown>,
    }),
  );
  return item;
}

export async function deleteDevice(deviceId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getTableName(),
      Key: deviceKey(deviceId),
    }),
  );
}

export async function queryDevicesByNode(nodeId: string): Promise<readonly DeviceEntity[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `DEVICE_NODE#${nodeId}`,
      },
    }),
  );
  return (result.Items ?? []).map(fromDeviceItem);
}

export async function queryAllDevices(): Promise<readonly DeviceEntity[]> {
  const result = await getDocClient().send(
    new ScanCommand({
      TableName: getTableName(),
      FilterExpression: "entityType = :et",
      ExpressionAttributeValues: { ":et": "Device" },
    }),
  );
  return (result.Items ?? []).map(fromDeviceItem);
}

export async function getDeviceByToken(token: string): Promise<DeviceEntity | undefined> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getTableName(),
      IndexName: "GSI3",
      KeyConditionExpression: "GSI3PK = :pk",
      ExpressionAttributeValues: {
        ":pk": `PROVISION#${token}`,
      },
      Limit: 1,
    }),
  );
  const item = result.Items?.[0];
  return item ? fromDeviceItem(item) : undefined;
}

export async function updateDeviceStatus(
  deviceId: string,
  enabled: boolean,
): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: deviceKey(deviceId),
      UpdateExpression: "SET #enabled = :enabled, #updatedAt = :now",
      ExpressionAttributeNames: {
        "#enabled": "enabled",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":enabled": enabled,
        ":now": now,
      },
    }),
  );
}

export async function updateDeviceUnifiPeerId(
  deviceId: string,
  unifiPeerId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getTableName(),
      Key: deviceKey(deviceId),
      UpdateExpression: "SET #upid = :upid, #status = :status, #updatedAt = :now",
      ExpressionAttributeNames: {
        "#upid": "unifiPeerId",
        "#status": "status",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":upid": unifiPeerId,
        ":status": "provisioned",
        ":now": now,
      },
    }),
  );
}
