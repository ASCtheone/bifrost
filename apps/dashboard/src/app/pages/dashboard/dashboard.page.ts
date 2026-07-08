import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { ApiService } from '../../services/api.service';
import { WsService } from '../../services/ws.service';

interface NodeInfo {
  readonly id: string;
  readonly status: string;
  readonly role: string;
  readonly syncState: string;
}

interface NodesResponse {
  readonly nodes: readonly {
    readonly id: string;
    readonly tunnelUrl: string;
    readonly role: string;
    readonly status: string;
  }[];
}

@Component({
  selector: 'app-dashboard',
  template: `
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-header">
          <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg>
          <span class="stat-label">Total Nodes</span>
        </div>
        <div class="stat-value">{{ nodeCount() }}</div>
      </div>

      <div class="stat-card">
        <div class="stat-header">
          <div class="stat-dot online"></div>
          <span class="stat-label">Online</span>
        </div>
        <div class="stat-value accent">{{ onlineCount() }}</div>
      </div>

      <div class="stat-card">
        <div class="stat-header">
          <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87m-4-12a4 4 0 010 7.75"/></svg>
          <span class="stat-label">Peers</span>
        </div>
        <div class="stat-value">{{ peerCount() }}</div>
      </div>

      <div class="stat-card" [class.has-issues]="errorCount() > 0">
        <div class="stat-header">
          <svg class="stat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span class="stat-label">Issues</span>
        </div>
        <div class="stat-value">{{ errorCount() }}</div>
      </div>
    </div>

    <div class="panels-row">
      <div class="panel">
        <div class="panel-header">
          <h3>Node Status</h3>
        </div>
        <div class="panel-body">
          @for (node of recentNodes(); track node.id) {
            <div class="node-row">
              <div class="node-row-left">
                <div class="status-dot" [class.online]="node.status === 'online'" [class.offline]="node.status === 'offline'"></div>
                <div>
                  <div class="node-row-name">{{ node.id }}</div>
                  <div class="node-row-role">{{ node.role }}</div>
                </div>
              </div>
              <span class="sync-pill"
                    [class.synced]="node.syncState === 'synced'"
                    [class.applying]="node.syncState === 'applying'"
                    [class.error]="node.syncState === 'error'"
                    [class.drift]="node.syncState === 'drift'">
                {{ node.syncState }}
              </span>
            </div>
          }
          @if (recentNodes().length === 0) {
            <div class="empty-state">No nodes registered</div>
          }
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h3>Quick Info</h3>
        </div>
        <div class="panel-body">
          <div class="info-row">
            <span class="info-label">Config Version</span>
            <span class="info-value">v{{ configVersion() }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Primary Node</span>
            <span class="info-value">{{ primaryNode() || 'None' }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Active Peers</span>
            <span class="info-value">{{ peerCount() }}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Offline Nodes</span>
            <span class="info-value" [class.warn]="offlineCount() > 0">{{ offlineCount() }}</span>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .stats-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem; }
    .stat-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    .stat-icon { width: 16px; height: 16px; color: var(--text-disabled); }
    .stat-dot { width: 8px; height: 8px; border-radius: 50%; }
    .stat-dot.online { background: var(--success); }
    .stat-label { font-size: 0.75rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.5px; }
    .stat-value { font-size: 1.75rem; font-weight: 600; color: var(--text-primary); }
    .stat-value.accent { color: var(--success); }
    .stat-card.has-issues { border-color: var(--error); }
    .stat-card.has-issues .stat-value { color: var(--error); }
    .stat-card.has-issues .stat-icon { color: var(--error); }
    .panels-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .panel { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .panel-header { padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); }
    .panel-header h3 { margin: 0; font-size: 0.875rem; font-weight: 600; color: var(--text-primary); }
    .panel-body { padding: 0.5rem 0; }
    .node-row { display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 1.25rem; transition: background 0.1s ease; }
    .node-row:hover { background: var(--sidebar-hover); }
    .node-row-left { display: flex; align-items: center; gap: 0.75rem; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .status-dot.online { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.offline { background: var(--text-disabled); }
    .node-row-name { font-size: 0.875rem; font-weight: 500; color: var(--text-primary); }
    .node-row-role { font-size: 0.75rem; color: var(--text-disabled); }
    .sync-pill { font-size: 0.7rem; padding: 2px 8px; border-radius: 10px; font-weight: 500; text-transform: capitalize; }
    .sync-pill.synced { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .sync-pill.applying { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); }
    .sync-pill.error { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); }
    .sync-pill.drift { background: color-mix(in srgb, var(--warning) 15%, transparent); color: var(--warning); }
    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 0.65rem 1.25rem; border-bottom: 1px solid var(--border); }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-size: 0.8rem; color: var(--text-tertiary); }
    .info-value { font-size: 0.8rem; font-weight: 500; color: var(--text-primary); }
    .info-value.warn { color: var(--error); }
    .empty-state { padding: 2rem; text-align: center; color: var(--text-disabled); font-size: 0.85rem; }
  `],
})
export class DashboardPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly ws = inject(WsService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubWs: (() => void) | null = null;

  nodeCount = signal(0);
  onlineCount = signal(0);
  offlineCount = signal(0);
  peerCount = signal(0);
  errorCount = signal(0);
  configVersion = signal(0);
  primaryNode = signal<string | null>(null);
  recentNodes = signal<NodeInfo[]>([]);

  ngOnInit(): void {
    this.fetchData();
    this.pollTimer = setInterval(() => this.fetchData(), 10000);
    this.unsubWs = this.ws.subscribe(() => this.fetchData());
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubWs?.();
  }

  private async fetchData(): Promise<void> {
    try {
      const res = await this.api.get<NodesResponse>('/nodes');
      const nodes = res.nodes;

      this.nodeCount.set(nodes.length);
      let online = 0;
      let offline = 0;
      let errors = 0;
      let primary: string | null = null;
      const infos: NodeInfo[] = [];

      for (const n of nodes) {
        if (n.status === 'online') online++;
        else offline++;
        if (n.role === 'primary') primary = n.id;
        infos.push({ id: n.id, status: n.status, role: n.role, syncState: 'synced' });
      }

      this.onlineCount.set(online);
      this.offlineCount.set(offline);
      this.errorCount.set(errors);
      this.primaryNode.set(primary);
      this.recentNodes.set(infos);
    } catch (err) {
      console.error('[dashboard] fetch failed:', err);
    }
  }
}
