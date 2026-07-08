import { table } from "./database.js";

export const wsApi = new sst.aws.ApiGatewayWebSocket("BifrostWs", {});

const wsHandlerDefaults = {
  link: [table],
  environment: {
    TABLE_NAME: table.name,
  },
};

wsApi.route("$connect", {
  ...wsHandlerDefaults,
  handler: "apps/spark-lambda/src/handlers/ws-connect.handler",
});

wsApi.route("$disconnect", {
  ...wsHandlerDefaults,
  handler: "apps/spark-lambda/src/handlers/ws-disconnect.handler",
});

wsApi.route("$default", {
  ...wsHandlerDefaults,
  handler: "apps/spark-lambda/src/handlers/ws-disconnect.handler",
});
