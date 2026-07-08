export interface SparkAgentConfig {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly controllerUrl: string;
  readonly controllerApiKey: string;
  readonly apiUrl: string;
  readonly wsUrl: string;
  readonly nodeKey: string;
  readonly tableName: string;
  readonly awsRegion: string;
  readonly port: number;
  readonly heartbeatIntervalMs: number;
}

export function loadOperationalConfig(
  nodeId: string,
  nodeName: string,
  apiUrl: string,
  wsUrl: string,
  nodeKey: string,
): SparkAgentConfig {
  return {
    nodeId,
    nodeName,
    controllerUrl: process.env["BIFROST_CONTROLLER_URL"] ?? "",
    controllerApiKey: process.env["BIFROST_CONTROLLER_API_KEY"] ?? "",
    apiUrl,
    wsUrl,
    nodeKey,
    tableName: process.env["TABLE_NAME"] ?? "",
    awsRegion: process.env["AWS_REGION"] ?? "us-east-1",
    port: parseInt(process.env["BIFROST_PORT"] ?? "8080", 10),
    heartbeatIntervalMs: parseInt(
      process.env["BIFROST_HEARTBEAT_MS"] ?? "30000",
      10,
    ),
  };
}
