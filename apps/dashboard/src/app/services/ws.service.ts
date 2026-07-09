import { Injectable, OnDestroy } from '@angular/core';
import { environment } from '../../environments/environment';

export type WsMessageHandler = (data: unknown) => void;

@Injectable({ providedIn: 'root' })
export class WsService implements OnDestroy {
  private ws: WebSocket | null = null;
  private handlers = new Set<WsMessageHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    // Realtime channel disabled when no WS URL is configured (spark-server is
    // HTTP-only). Pages still load their data over the REST API.
    if (!environment.wsUrl) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    try {
      this.ws = new WebSocket(environment.wsUrl);

      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data as string);
          this.handlers.forEach((h) => h(data));
        } catch {
          // ignore parse errors
        }
      };

      this.ws.onclose = () => {
        this.reconnectTimer = setTimeout(() => this.connect(), 5000);
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.reconnectTimer = setTimeout(() => this.connect(), 5000);
    }
  }

  subscribe(handler: WsMessageHandler): () => void {
    this.handlers.add(handler);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.connect();
    }
    return () => this.handlers.delete(handler);
  }

  ngOnDestroy(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
