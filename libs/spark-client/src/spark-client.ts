import type { SparkClientConfig, SparkNode, SparkPeer } from "./types.js";
import { NodeSelector } from "./node-selector.js";
import { FailoverFetch } from "./failover-fetch.js";
import { SseClient, type SseEventHandler } from "./sse-client.js";

export class SparkClient {
  private readonly config: SparkClientConfig;
  private readonly selector: NodeSelector;
  private readonly fetcher: FailoverFetch;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private sseClient: SseClient | null = null;

  constructor(config: SparkClientConfig) {
    this.config = config;
    this.selector = new NodeSelector(config.stickyFailover ?? false);
    this.fetcher = new FailoverFetch(
      this.selector,
      config.authToken,
      config.requestTimeoutMs ?? 3000,
    );
  }

  async init(nodes: readonly SparkNode[]): Promise<void> {
    this.selector.updateNodes(nodes);
  }

  async refreshNodes(): Promise<readonly SparkNode[]> {
    const response = await fetch(`${this.config.apiBaseUrl}/getNodeList`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data: {} }),
    });

    if (!response.ok) {
      throw new Error(`Failed to refresh nodes: ${response.status}`);
    }

    const result = (await response.json()) as { result: { nodes: SparkNode[] } };
    const nodes = result.result.nodes;
    this.selector.updateNodes(nodes);
    return nodes;
  }

  startNodeRefresh(): void {
    const interval = this.config.nodeRefreshIntervalMs ?? 300000; // 5min
    this.refreshTimer = setInterval(() => {
      this.refreshNodes().catch((err) =>
        console.error("[spark] node refresh failed:", err),
      );
    }, interval);
  }

  stopNodeRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // --- Peer CRUD (via node API with failover) ---

  async createPeer(name: string, serverId: string): Promise<SparkPeer> {
    return this.fetcher.request<SparkPeer>("/peers", {
      method: "POST",
      body: { name, serverId },
    });
  }

  async listPeers(): Promise<{ peers: SparkPeer[] }> {
    return this.fetcher.request("/peers");
  }

  async getPeer(peerId: string): Promise<SparkPeer> {
    return this.fetcher.request(`/peers/${peerId}`);
  }

  async updatePeer(
    peerId: string,
    updates: { name?: string; allowedIps?: string[]; enabled?: boolean },
  ): Promise<SparkPeer> {
    return this.fetcher.request(`/peers/${peerId}`, {
      method: "PUT",
      body: updates,
    });
  }

  async deletePeer(peerId: string): Promise<void> {
    await this.fetcher.request(`/peers/${peerId}`, { method: "DELETE" });
  }

  // --- SSE config stream ---

  connectSse(peerId: string, handler: SseEventHandler): void {
    this.disconnectSse();
    this.sseClient = new SseClient(
      this.selector,
      this.config.authToken,
      peerId,
    );
    this.sseClient.onEvent(handler);
    this.sseClient.start();
  }

  disconnectSse(): void {
    if (this.sseClient) {
      this.sseClient.stop();
      this.sseClient = null;
    }
  }

  // --- Lifecycle ---

  getCurrentNode(): SparkNode | null {
    return this.selector.current();
  }

  getAllNodes(): readonly SparkNode[] {
    return this.selector.getAll();
  }

  shutdown(): void {
    this.stopNodeRefresh();
    this.disconnectSse();
  }
}
