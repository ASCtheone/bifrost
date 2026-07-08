import { Component, inject, signal, OnInit } from '@angular/core';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';
import { ConfirmService } from '../../services/confirm.service';

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly adoptionStatus: string;
  readonly role: string;
  readonly wanIp: string | null;
  readonly geo: { city?: string; country?: string } | null;
  readonly ispName: string | null;
  readonly speedDown: number | null;
  readonly speedUp: number | null;
  readonly ownerId: string | null;
  readonly ownerEmail: string | null;
  readonly lastSeen: string;
}

interface NodesResponse {
  readonly nodes: readonly NodeRow[];
}

@Component({
  selector: 'app-admin-nodes',
  imports: [FaIconComponent],
  template: `
    <div class="page-header">
      <h2>All Sparks</h2>
      <span class="subtitle">Superadmin view — all sparks across all owners</span>
    </div>

    @for (group of ownerGroups(); track group.owner) {
      <div class="owner-section">
        <div class="owner-header">
          <fa-icon [icon]="['fal', 'users']" [fixedWidth]="true"></fa-icon>
          <span class="owner-name">{{ group.ownerEmail || 'Unassigned' }}</span>
          <span class="node-count">{{ group.nodes.length }} spark{{ group.nodes.length !== 1 ? 's' : '' }}</span>
        </div>
        <div class="nodes-grid">
          @for (node of group.nodes; track node.id) {
            <div class="node-card-mini" [class.online]="node.status === 'online'" [class.offline]="node.status !== 'online'">
              <div class="node-top">
                <div class="node-name">{{ node.name }}</div>
                <span class="status-dot" [class.online]="node.status === 'online'"></span>
              </div>
              <div class="node-meta">
                @if (node.geo?.city) {
                  <span class="meta-item location">{{ node.geo!.city }}, {{ node.geo!.country }}</span>
                }
                @if (node.wanIp) {
                  <span class="meta-item ip">{{ node.wanIp }}</span>
                }
              </div>
              <div class="node-bottom">
                <span class="role-pill" [class.primary]="node.role === 'primary'">{{ node.role }}</span>
                <span class="adoption-pill" [attr.data-status]="node.adoptionStatus">{{ node.adoptionStatus }}</span>
                @if (node.speedDown) {
                  <span class="speed">↓{{ node.speedDown }} ↑{{ node.speedUp }} Mbps</span>
                }
              </div>
              <div class="node-actions-mini">
                <button class="action-btn-sm danger" (click)="deleteNode(node)" title="Delete">
                  <fa-icon [icon]="['fal', 'trash-can']" [fixedWidth]="true"></fa-icon>
                </button>
              </div>
            </div>
          }
        </div>
      </div>
    }

    @if (ownerGroups().length === 0 && !loading()) {
      <div class="empty-state">No sparks found</div>
    }
  `,
  styles: [`
    .page-header { margin-bottom: 1.25rem; }
    .page-header h2 { margin: 0; font-size: 1.1rem; color: var(--text-primary); font-weight: 600; }
    .subtitle { font-size: 0.7rem; color: var(--text-disabled); }

    .owner-section { margin-bottom: 1.5rem; }
    .owner-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.6rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--border); }
    .owner-header fa-icon { color: var(--text-disabled); font-size: 0.8rem; }
    .owner-name { font-size: 0.85rem; font-weight: 600; color: var(--text-primary); }
    .node-count { font-size: 0.65rem; color: var(--text-disabled); margin-left: auto; }

    .nodes-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 0.6rem; }
    .node-card-mini { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; padding: 0.75rem; position: relative; transition: border-color 0.15s ease; }
    .node-card-mini:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .node-card-mini.online { border-left: 3px solid var(--success); }
    .node-card-mini.offline { border-left: 3px solid var(--text-disabled); }

    .node-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.35rem; }
    .node-name { font-weight: 600; font-size: 0.85rem; color: var(--text-primary); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-disabled); }
    .status-dot.online { background: var(--success); box-shadow: 0 0 6px var(--success); }

    .node-meta { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.35rem; }
    .meta-item { font-size: 0.6rem; color: var(--text-disabled); }
    .meta-item.location { color: var(--accent); }
    .meta-item.ip { font-family: monospace; }

    .node-bottom { display: flex; gap: 0.3rem; align-items: center; flex-wrap: wrap; }
    .role-pill { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 0.55rem; font-weight: 600; text-transform: uppercase; background: var(--bg-input); color: var(--text-tertiary); }
    .role-pill.primary { background: var(--accent); color: #fff; }
    .adoption-pill { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 0.5rem; font-weight: 600; text-transform: uppercase; }
    .adoption-pill[data-status="adopted"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .adoption-pill[data-status="pending"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }
    .adoption-pill[data-status="available"] { background: color-mix(in srgb, #3b82f6 15%, transparent); color: #3b82f6; }
    .speed { font-size: 0.55rem; color: var(--success); margin-left: auto; }

    .node-actions-mini { position: absolute; top: 0.5rem; right: 0.5rem; opacity: 0; transition: opacity 0.15s ease; }
    .node-card-mini:hover .node-actions-mini { opacity: 1; }
    .action-btn-sm { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: var(--bg-surface); border: 1px solid var(--border); color: var(--text-disabled); border-radius: 4px; cursor: pointer; font-size: 0.65rem; }
    .action-btn-sm.danger:hover { color: var(--error); border-color: var(--error); }

    .empty-state { text-align: center; color: var(--text-disabled); padding: 2.5rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; }
  `],
})
export class AdminNodesPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly confirmSvc = inject(ConfirmService);

  loading = signal(true);
  ownerGroups = signal<{ owner: string; ownerEmail: string; nodes: NodeRow[] }[]>([]);

  ngOnInit(): void {
    this.fetchNodes();
  }

  private async fetchNodes(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.get<NodesResponse>('/nodes?all=true');
      const grouped = new Map<string, { ownerEmail: string; nodes: NodeRow[] }>();

      for (const node of res.nodes) {
        const key = node.ownerId ?? 'unassigned';
        if (!grouped.has(key)) {
          grouped.set(key, { ownerEmail: node.ownerEmail ?? '', nodes: [] });
        }
        grouped.get(key)!.nodes.push(node);
      }

      this.ownerGroups.set(
        Array.from(grouped.entries()).map(([owner, g]) => ({
          owner,
          ownerEmail: g.ownerEmail,
          nodes: g.nodes,
        })),
      );
    } catch (err) {
      console.error('[admin-nodes] fetch failed:', err);
    } finally {
      this.loading.set(false);
    }
  }

  async deleteNode(node: NodeRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete Spark',
      message: `Delete "${node.name}" owned by ${node.ownerEmail ?? 'unknown'}?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.api.delete(`/nodes/${node.id}`);
    await this.fetchNodes();
  }
}
