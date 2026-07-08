import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { putConnection } from "@bifrost/dynamo-repo";

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const connectionId = event.requestContext.connectionId;

  await putConnection(connectionId);

  return { statusCode: 200, body: "Connected" };
}
