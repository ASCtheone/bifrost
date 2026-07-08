import type { NodeSelector } from "./node-selector.js";

export interface FailoverRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export class FailoverFetch {
  private readonly selector: NodeSelector;
  private readonly authToken: string;
  private readonly defaultTimeoutMs: number;

  constructor(
    selector: NodeSelector,
    authToken: string,
    defaultTimeoutMs: number = 3000,
  ) {
    this.selector = selector;
    this.authToken = authToken;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async request<T>(
    path: string,
    options: FailoverRequestOptions = {},
  ): Promise<T> {
    const nodes = this.selector.getAll();
    let lastError: Error | undefined;

    // Try current node first, then failover through all nodes
    for (let attempt = 0; attempt < nodes.length; attempt++) {
      const node = attempt === 0
        ? this.selector.current()
        : this.selector.failover();

      if (!node) break;

      try {
        return await this.doRequest<T>(node.tunnelUrl, path, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(
          `[failover] Node ${node.id} (${node.tunnelUrl}) failed: ${lastError.message}`,
        );
      }
    }

    throw lastError ?? new Error("No nodes available");
  }

  private async doRequest<T>(
    baseUrl: string,
    path: string,
    options: FailoverRequestOptions,
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.authToken}`,
          "Content-Type": "application/json",
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
