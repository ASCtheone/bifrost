import type { NodeSelector } from "./node-selector.js";
import type { SseEvent, SseEventType } from "./types.js";

export type SseEventHandler = (event: SseEvent) => void;

export class SseClient {
  private readonly selector: NodeSelector;
  private readonly authToken: string;
  private readonly peerId: string;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private handlers: SseEventHandler[] = [];
  private running = false;

  constructor(selector: NodeSelector, authToken: string, peerId: string) {
    this.selector = selector;
    this.authToken = authToken;
    this.peerId = peerId;
  }

  onEvent(handler: SseEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private connect(): void {
    if (!this.running) return;

    const node = this.selector.current();
    if (!node) {
      this.scheduleReconnect(5000);
      return;
    }

    const url = `${node.tunnelUrl}/config/stream?peerId=${this.peerId}`;
    this.controller = new AbortController();

    console.log(`[sse] Connecting to ${node.id} (${url})`);

    fetch(url, {
      headers: { Authorization: `Bearer ${this.authToken}` },
      signal: this.controller.signal,
    })
      .then((response) => {
        if (!response.ok || !response.body) {
          throw new Error(`SSE connection failed: ${response.status}`);
        }
        return this.readStream(response.body);
      })
      .catch((error) => {
        if (!this.running) return;

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[sse] Connection to ${node.id} lost: ${message}`);

        // Try failover to next node
        const next = this.selector.failover();
        if (next) {
          console.log(`[sse] Failing over to ${next.id}`);
          this.connect();
        } else {
          this.scheduleReconnect(5000);
        }
      });
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const events = this.parseEvents(buffer);
        buffer = events.remaining;

        for (const event of events.parsed) {
          this.emit(event);
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Stream ended — reconnect
    if (this.running) {
      this.scheduleReconnect(1000);
    }
  }

  private parseEvents(buffer: string): {
    parsed: SseEvent[];
    remaining: string;
  } {
    const parsed: SseEvent[] = [];
    const blocks = buffer.split("\n\n");

    // Last block may be incomplete
    const remaining = blocks.pop() ?? "";

    for (const block of blocks) {
      if (!block.trim() || block.startsWith(":")) continue;

      let eventType: SseEventType = "config";
      let data = "";

      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim() as SseEventType;
        } else if (line.startsWith("data: ")) {
          data = line.slice(6);
        }
      }

      if (data) {
        try {
          parsed.push({ type: eventType, data: JSON.parse(data) });
        } catch {
          parsed.push({ type: eventType, data });
        }
      }
    }

    return { parsed, remaining };
  }

  private emit(event: SseEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        console.error("[sse] handler error:", err);
      }
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (!this.running) return;
    console.log(`[sse] Reconnecting in ${delayMs}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.selector.reset();
      this.connect();
    }, delayMs);
  }
}
