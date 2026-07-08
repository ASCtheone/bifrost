import type { DynamoDBStreamEvent } from "aws-lambda";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getAllConnections, deleteConnection } from "@bifrost/dynamo-repo";

function getWsApiEndpoint(): string {
  const url = process.env["WS_API_ENDPOINT"];
  if (!url) {
    throw new Error("WS_API_ENDPOINT environment variable is required");
  }
  return url;
}

export async function handler(event: DynamoDBStreamEvent) {
  const connections = await getAllConnections();
  if (connections.length === 0) {
    return;
  }

  const client = new ApiGatewayManagementApiClient({
    endpoint: getWsApiEndpoint(),
  });

  // Build change notifications from the stream records
  const changes = event.Records.map((record) => ({
    eventName: record.eventName,
    keys: record.dynamodb?.Keys,
    newImage: record.dynamodb?.NewImage,
  }));

  const payload = new TextEncoder().encode(
    JSON.stringify({ type: "change", changes }),
  );

  const sendPromises = connections.map(async (conn) => {
    try {
      await client.send(
        new PostToConnectionCommand({
          ConnectionId: conn.connectionId,
          Data: payload,
        }),
      );
    } catch (err: unknown) {
      const error = err as { statusCode?: number };
      if (error.statusCode === 410) {
        // Connection is gone, clean it up
        await deleteConnection(conn.connectionId);
      }
    }
  });

  await Promise.all(sendPromises);
}
