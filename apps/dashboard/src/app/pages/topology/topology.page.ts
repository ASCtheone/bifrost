import { Component, inject, signal, OnInit } from '@angular/core';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';

interface TDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly assignedIp: string;
  readonly ownerEmail: string | null;
}
interface TSpark {
  readonly nodeId: string;
  readonly name: string;
  readonly status: string;
  readonly adoptionStatus: string;
  readonly shared: boolean;
  readonly ownerEmail: string | null;
  readonly devices: readonly TDevice[];
}
interface TUser {
  readonly email: string;
  readonly role: string;
  readonly isSelf: boolean;
  readonly sparks: readonly TSpark[];
}
interface Topology {
  readonly view: 'superadmin' | 'user';
  readonly users: readonly TUser[];
}

@Component({
  selector: 'app-topology',
  standalone: true,
  imports: [FaIconComponent],
  template: `
    <div class="page">
      <div class="page-head">
        <h2>Topology</h2>
        @if (topology(); as t) {
          <span class="view-pill">{{ t.view === 'superadmin' ? 'All users' : 'Your access' }}</span>
        }
      </div>

      @if (loading()) {
        <div class="state"><fa-icon [icon]="['fal', 'circle-notch']" class="spin"></fa-icon> Loading topology…</div>
      } @else if (error()) {
        <div class="state error">{{ error() }}</div>
      } @else if (topology(); as t) {
        @if (!t.users.length) {
          <div class="state">Nothing to show yet.</div>
        } @else {
          <div class="tree-scroll">
            <div class="tree">
              <ul>
                <li>
                  <div class="node root-node">
                    <fa-icon [icon]="['fal', 'sitemap']" [fixedWidth]="true"></fa-icon>
                    <span>{{ t.view === 'superadmin' ? 'All Users' : 'My Network' }}</span>
                  </div>
                  <ul>
                    @for (user of t.users; track user.email) {
                      <li>
                        <div class="node user-node" [class.self]="user.isSelf">
                          <fa-icon [icon]="['fal', 'users']" [fixedWidth]="true"></fa-icon>
                          <div class="node-body">
                            <span class="node-title">{{ user.email }}</span>
                            <span class="node-sub">{{ user.role }}</span>
                          </div>
                        </div>
                        @if (user.sparks.length) {
                          <ul>
                            @for (spark of user.sparks; track spark.nodeId) {
                              <li>
                                <div class="node spark-node">
                                  <span class="dot" [class]="statusClass(spark.status)"></span>
                                  <fa-icon [icon]="['fal', 'server']" [fixedWidth]="true"></fa-icon>
                                  <div class="node-body">
                                    <span class="node-title">{{ spark.name }}</span>
                                    <span class="node-sub">
                                      {{ spark.status }}
                                      @if (spark.shared) { · <span class="shared-tag">shared</span> }
                                    </span>
                                  </div>
                                </div>
                                @if (spark.devices.length) {
                                  <ul>
                                    @for (dev of spark.devices; track dev.deviceId) {
                                      <li>
                                        <div class="node device-node">
                                          <span class="dot" [class]="statusClass(dev.status)"></span>
                                          <fa-icon [icon]="['fal', 'laptop-mobile']" [fixedWidth]="true"></fa-icon>
                                          <div class="node-body">
                                            <span class="node-title">{{ dev.name }}</span>
                                            <span class="node-sub mono">{{ dev.assignedIp }}</span>
                                          </div>
                                        </div>
                                      </li>
                                    }
                                  </ul>
                                }
                              </li>
                            }
                          </ul>
                        }
                      </li>
                    }
                  </ul>
                </li>
              </ul>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .page { padding: 1.5rem; }
    .page-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
    .page-head h2 { margin: 0; }
    .view-pill { padding: 3px 10px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
    .state { padding: 2rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.5rem; }
    .state.error { color: var(--danger, #ef4444); }
    .spin { animation: tspin 1s linear infinite; }
    @keyframes tspin { to { transform: rotate(360deg); } }

    .tree-scroll { overflow-x: auto; padding-bottom: 1rem; }
    .tree { display: inline-block; min-width: 100%; }
    .tree ul { position: relative; padding-top: 22px; display: flex; justify-content: center; }
    .tree li { list-style: none; position: relative; padding: 22px 10px 0; display: flex; flex-direction: column; align-items: center; }
    /* Connector lines (classic CSS org-chart technique). */
    .tree li::before, .tree li::after {
      content: ''; position: absolute; top: 0; right: 50%;
      border-top: 1px solid var(--border); width: 50%; height: 22px;
    }
    .tree li::after { right: auto; left: 50%; border-left: 1px solid var(--border); }
    .tree li:only-child::before, .tree li:only-child::after { display: none; }
    .tree li:only-child { padding-top: 0; }
    .tree li:first-child::before, .tree li:last-child::after { border: 0 none; }
    .tree li:last-child::before { border-right: 1px solid var(--border); border-radius: 0 6px 0 0; }
    .tree li:first-child::after { border-radius: 6px 0 0 0; }
    .tree ul ul::before {
      content: ''; position: absolute; top: 0; left: 50%;
      border-left: 1px solid var(--border); width: 0; height: 22px;
    }
    .tree > ul { padding-top: 0; }

    .node { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.75rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 10px; white-space: nowrap; }
    .node fa-icon { color: var(--text-tertiary); }
    .node-body { display: flex; flex-direction: column; text-align: left; line-height: 1.25; }
    .node-title { font-size: 0.8rem; font-weight: 600; color: var(--text-primary); }
    .node-sub { font-size: 0.66rem; color: var(--text-tertiary); }
    .node-sub.mono { font-family: ui-monospace, monospace; }
    .mono { font-family: ui-monospace, monospace; }

    .root-node { background: color-mix(in srgb, var(--accent) 12%, var(--bg-surface)); border-color: var(--accent); font-weight: 700; font-size: 0.85rem; color: var(--accent); }
    .root-node fa-icon { color: var(--accent); }
    .user-node.self { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, var(--bg-surface)); }
    .shared-tag { color: var(--warning, #f59e0b); font-weight: 600; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex-shrink: 0; }
    .dot.online { background: var(--success, #22c55e); }
    .dot.offline { background: var(--text-disabled, #9ca3af); }
    .dot.warn { background: var(--warning, #f59e0b); }
  `],
})
export class TopologyPage implements OnInit {
  private api = inject(ApiService);

  topology = signal<Topology | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      this.topology.set(await this.api.get<Topology>('/topology'));
    } catch {
      this.error.set('Failed to load topology.');
    } finally {
      this.loading.set(false);
    }
  }

  statusClass(status: string): string {
    if (status === 'online' || status === 'active' || status === 'provisioned') return 'online';
    if (status === 'pending') return 'warn';
    return 'offline';
  }
}
