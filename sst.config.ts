/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "bifrost",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const { database, table } = await import("./infra/database.js");
    const { auth, userPoolClient } = await import("./infra/auth.js");
    const { api } = await import("./infra/api.js");
    const { wsApi } = await import("./infra/websocket.js");
    await import("./infra/scheduler.js");

    return {
      apiUrl: api.url,
      wsUrl: wsApi.url,
      tableArn: table.arn,
      tableName: table.name,
      userPoolId: auth.id,
      userPoolClientId: userPoolClient.id,
    };
  },
});
