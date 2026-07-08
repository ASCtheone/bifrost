import type { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { deleteConnection } from "@bifrost/dynamo-repo";

export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const connectionId = event.requestContext.connectionId;

  await deleteConnection(connectionId);

  return { statusCode: 200, body: "Disconnected" };
}
