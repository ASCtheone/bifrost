import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { WsService } from '../../services/ws.service';
import { ConfirmService } from '../../services/confirm.service';

interface PeerRow {
  readonly id: string;
  readonly name: string;
  readonly assignedIp: string;
  readonly nodeId: string;
  readonly enabled: boolean;
  readonly createdAt: string;
}

interface PeersResponse {
  readonly peers: readonly {
    readonly id: string;
    readonly name: string;
    readonly assignedIp: string;
    readonly nodeId: string;
    readonly enabled: boolean;
    readonly createdAt: string;
  }[];
}

@Component({
  selector: 'app-peers',
  template: `
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>IP Address</th>
            <th>Node</th>
            <th>Status</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (peer of peers(); track peer.id) {
            <tr>
              <td class="cell-primary">{{ peer.name }}</td>
              <td><code class="ip-badge">{{ peer.assignedIp }}</code></td>
              <td>{{ peer.nodeId }}</td>
              <td>
                <span class="status-pill" [class.active]="peer.enabled" [class.disabled]="!peer.enabled">
                  {{ peer.enabled ? 'Active' : 'Disabled' }}
                </span>
              </td>
              <td class="cell-secondary">{{ peer.createdAt }}</td>
              <td class="cell-actions">
                <button class="action-btn danger" (click)="deletePeer(peer.id, peer.name)" title="Delete peer">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                </button>
              </td>
            </tr>
          }
          @if (peers().length === 0) {
            <tr><td colspan="6" class="empty-state">No peers yet — peers are created via the client app</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .table-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    thead { background: var(--bg-secondary); }
    th { padding: 0.65rem 1rem; text-align: left; font-size: 0.7rem; font-weight: 600; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 0.75rem 1rem; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--text-secondary); }
    tr:hover td { background: color-mix(in srgb, var(--sidebar-hover) 50%, transparent); }
    .cell-primary { font-weight: 500; color: var(--text-primary); }
    .cell-secondary { color: var(--text-disabled); font-size: 0.8rem; }
    .ip-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; background: var(--bg-input); font-size: 0.8rem; font-family: monospace; color: var(--text-primary); }
    .status-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.7rem; font-weight: 500; }
    .status-pill.active { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .status-pill.disabled { background: var(--bg-input); color: var(--text-disabled); }
    .cell-actions { text-align: right; }
    .action-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; background: none; border: 1px solid var(--border); color: var(--text-tertiary); border-radius: 6px; cursor: pointer; transition: all 0.15s ease; }
    .action-btn.danger:hover { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); border-color: var(--error); }
    .empty-state { text-align: center; color: var(--text-disabled); padding: 2.5rem; }
  `],
})
export class PeersPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly ws = inject(WsService);
  private readonly confirmSvc = inject(ConfirmService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubWs: (() => void) | null = null;

  peers = signal<PeerRow[]>([]);

  ngOnInit(): void {
    this.fetchPeers();
    this.pollTimer = setInterval(() => this.fetchPeers(), 10000);
    this.unsubWs = this.ws.subscribe(() => this.fetchPeers());
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubWs?.();
  }

  private async fetchPeers(): Promise<void> {
    try {
      const res = await this.api.get<PeersResponse>('/peers');
      this.peers.set(res.peers.map((p) => ({
        ...p,
        createdAt: p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '',
      })));
    } catch (err) {
      console.error('[peers] fetch failed:', err);
    }
  }

  async deletePeer(peerId: string, name: string): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete Peer',
      message: `Delete peer "${name}"?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.api.delete(`/peers/${peerId}`);
    await this.fetchPeers();
  }
}
