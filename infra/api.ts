import { auth, userPoolClient } from "./auth.js";
import { table } from "./database.js";

export const api = new sst.aws.ApiGatewayV2("BifrostApi", {
  cors: {
    allowOrigins: ["*"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Node-Key"],
  },
});

const authorizer = new aws.apigatewayv2.Authorizer("BifrostJwtAuth", {
  apiId: api.nodes.api.id,
  authorizerType: "JWT",
  name: "cognito",
  identitySources: ["$request.header.Authorization"],
  jwtConfiguration: {
    audiences: [userPoolClient.id],
    issuer: $interpolate`https://cognito-idp.${aws.getRegionOutput().name}.amazonaws.com/${auth.id}`,
  },
});

const routeDefaults = {
  link: [table],
  environment: {
    TABLE_NAME: table.name,
    COGNITO_USER_POOL_ID: auth.id,
  },
};

const routeDefaultsWithUrls = {
  ...routeDefaults,
  environment: {
    TABLE_NAME: table.name,
    BIFROST_API_URL: api.url,
    BIFROST_WS_URL: "", // populated after wsApi is created
  },
};

// ── Admin routes (JWT auth) ─────────────────────────────────────

api.route("GET /nodes", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/get-node-list.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes", {
  ...routeDefaultsWithUrls,
  handler: "apps/spark-lambda/src/handlers/create-node.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("GET /nodes/{nodeId}/config", {
  ...routeDefaultsWithUrls,
  handler: "apps/spark-lambda/src/handlers/get-node-config.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes/{nodeId}/adopt", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/adopt-node.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes/{nodeId}/create-vpn", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/create-vpn.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("GET /nodes/{nodeId}/shares", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/share-spark.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes/{nodeId}/share", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/share-spark.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("DELETE /nodes/{nodeId}/share", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/share-spark.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes/{nodeId}/revoke", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/revoke-node-key.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("PUT /nodes/{nodeId}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/update-node.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("DELETE /nodes/{nodeId}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/remove-node.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /nodes/{nodeId}/delete-peer", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/delete-node-peer.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("PUT /nodes/{nodeId}/role", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/set-node-role.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("PUT /vpn-config", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/update-vpn-config.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /force-resync", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/force-resync.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── User management routes (JWT auth + Cognito permissions) ─────

const userRouteDefaults = {
  link: [table],
  environment: {
    TABLE_NAME: table.name,
    COGNITO_USER_POOL_ID: auth.id,
  },
  permissions: [
    {
      actions: ["cognito-idp:*"],
      resources: [auth.arn],
    },
  ],
};

api.route("GET /users", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/list-users.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /users", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/create-user.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("PUT /users/{username}", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/update-user.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("DELETE /users/{username}", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/delete-user.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── Auth provision (auto-create device on login) ────────────────

api.route("POST /auth/provision", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/auth-provision.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── Connection logs ─────────────────────────────────────────────

api.route("GET /devices/{deviceId}/logs", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/connection-log.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /devices/{deviceId}/logs", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/connection-log.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── Admin dashboard (mobile app) ────────────────────────────────

api.route("GET /admin/dashboard", {
  ...userRouteDefaults,
  handler: "apps/spark-lambda/src/handlers/admin-dashboard.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── Unauthenticated routes (adoption code / node key auth in handler) ──

api.route("POST /agent/register", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/register-node-agent.handler",
});

api.route("GET /agent/await-adoption", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/await-adoption.handler",
});

// ── Node-key authenticated routes (spark-agent operational) ─────

api.route("PUT /nodes/{nodeId}/heartbeat", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/node-heartbeat.handler",
});

api.route("GET /nodes/{nodeId}/self", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/get-node-self.handler",
});

// ── Device routes (JWT auth) ────────────────────────────────────

api.route("GET /devices", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/list-devices.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /devices", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/create-device.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("PUT /devices/{deviceId}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/update-device.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("POST /devices/{deviceId}/sync", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/sync-device.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("DELETE /devices/{deviceId}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/delete-device.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("GET /devices/{deviceId}/config", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/get-device-config.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

// ── Public provision endpoint (token auth in handler) ───────────

api.route("GET /provision/{token}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/provision-device.handler",
});

api.route("GET /peers", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/get-peer-list.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});

api.route("DELETE /peers/{peerId}", {
  ...routeDefaults,
  handler: "apps/spark-lambda/src/handlers/delete-peer.handler",
  auth: { jwt: { authorizer: authorizer.id } },
});
