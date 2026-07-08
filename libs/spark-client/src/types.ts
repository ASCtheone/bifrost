export interface SparkNode {
  readonly id: string;
  readonly tunnelUrl: string;
  readonly role: "primary" | "secondary";
  readonly status: "online" | "offline";
}

export interface SparkClientConfig {
  readonly apiBaseUrl: string;
  readonly authToken: string;
  readonly requestTimeoutMs?: number;
  readonly nodeRefreshIntervalMs?: number;
  readonly stickyFailover?: boolean;
}

export interface SparkPeer {
  readonly id: string;
  readonly name: string;
  readonly assignedIp: string;
  readonly publicKey: string;
  readonly allowedIps: readonly string[];
  readonly enabled: boolean;
}

export type SseEventType = "config" | "vpnConfig" | "deleted" | "error";

export interface SseEvent {
  readonly type: SseEventType;
  readonly data: unknown;
}
