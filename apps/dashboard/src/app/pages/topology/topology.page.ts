import { Component, inject, signal, computed, OnInit, HostListener } from '@angular/core';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';

interface TDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly type: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly assignedIp: string;
  readonly ownerEmail: string | null;
}
interface TSpark {
  readonly nodeId: string;
  readonly name: string;
  readonly status: string;
  readonly paused: boolean;
  readonly adoptionStatus: string;
  readonly shared: boolean;
  readonly ownerEmail: string | null;
  readonly devices: readonly TDevice[];
}
interface TUser {
  readonly email: string;
  readonly role: string;
  readonly username?: string | null;
  readonly enabled?: boolean | null;
  readonly isSelf: boolean;
  readonly sparks: readonly TSpark[];
}
interface Topology {
  readonly view: 'superadmin' | 'user';
  readonly users: readonly TUser[];
}

type NodeKind = 'root' | 'user' | 'spark' | 'device';

interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  status?: string;
  shared?: boolean;
  x: number;
  y: number;
  // The source object (TUser/TSpark/TDevice) for the detail panel.
  data: unknown;
}
interface GraphEdge {
  from: string;
  to: string;
}

const TIER_Y: Record<NodeKind, number> = { root: 60, user: 190, spark: 330, device: 470 };
const X_GAP = 175;

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
        <div class="head-actions">
          <button class="btn-sm secondary" (click)="resetView()" title="Reset pan/zoom">Reset view</button>
        </div>
      </div>

      @if (loading()) {
        <div class="state"><fa-icon [icon]="['fal', 'circle-notch']" class="spin"></fa-icon> Loading topology…</div>
      } @else if (error()) {
        <div class="state error">{{ error() }}</div>
      } @else if (!nodes().length) {
        <div class="state">Nothing to show yet.</div>
      } @else {
        <div class="graph-layout" [class.panel-open]="selected()">
          <div class="graph-wrap" (mousedown)="onBgDown($event)" (wheel)="onWheel($event)">
            <svg class="graph" width="100%" height="100%">
              <g [attr.transform]="'translate(' + t().x + ',' + t().y + ') scale(' + t().k + ')'">
                @for (e of edges(); track e.from + e.to) {
                  @if (pos(e.from); as a) {
                    @if (pos(e.to); as b) {
                      <line [attr.x1]="a.x" [attr.y1]="a.y" [attr.x2]="b.x" [attr.y2]="b.y" class="edge" />
                    }
                  }
                }
                @for (n of nodes(); track n.id) {
                  <g [attr.transform]="'translate(' + n.x + ',' + n.y + ')'"
                     class="gnode" [class]="n.kind"
                     [class.selected]="selected()?.id === n.id"
                     (mousedown)="onNodeDown($event, n)">
                    <circle r="22" class="node-circle" />
                    <foreignObject x="-13" y="-13" width="26" height="26">
                      <span xmlns="http://www.w3.org/1999/xhtml" class="fo-ic"><fa-icon [icon]="['fal', iconFor(n.kind)]"></fa-icon></span>
                    </foreignObject>
                    @if (n.status) {
                      <circle cx="16" cy="-16" r="5" [attr.class]="'sdot ' + statusClass(n.status)" />
                    }
                    @if (n.shared) {
                      <circle cx="-16" cy="-16" r="5" class="sdot shared-dot" />
                    }
                    <text y="40" text-anchor="middle" class="nlabel">{{ trunc(n.label) }}</text>
                  </g>
                }
              </g>
            </svg>
            <div class="graph-hint">drag to pan · scroll to zoom · drag a node to move it · click to inspect</div>
          </div>

          @if (selected(); as sel) {
            <aside class="detail-panel">
              <div class="detail-head">
                <div class="detail-title">
                  <fa-icon [icon]="['fal', iconFor(sel.kind)]" [fixedWidth]="true"></fa-icon>
                  <span>{{ sel.label }}</span>
                </div>
                <button class="icon-btn" (click)="clearSelection()" title="Close"><fa-icon [icon]="['fal', 'xmark']" [fixedWidth]="true"></fa-icon></button>
              </div>
              <div class="detail-kind">{{ kindLabel(sel.kind) }}</div>

              @if (hasQuick(sel)) {
                <div class="quickbar">
                  @if (sel.kind === 'spark' && asSpark(sel); as s) {
                    <button class="qbtn" (click)="togglePause(s)" [disabled]="busy()" [title]="s.paused ? 'Resume' : 'Pause'">
                      <fa-icon [icon]="['fal', s.paused ? 'circle-check' : 'ban']" [fixedWidth]="true"></fa-icon>
                    </button>
                    <button class="qbtn" (click)="createVpn(s)" [disabled]="busy()" [title]="s.status === 'online' ? 'Recreate VPN' : 'Create VPN'">
                      <fa-icon [icon]="['fal', 'bolt']" [fixedWidth]="true"></fa-icon>
                    </button>
                  }
                  @if (sel.kind === 'device' && asDevice(sel); as d) {
                    <button class="qbtn" (click)="toggleDevice(d)" [disabled]="busy()" [title]="d.enabled ? 'Disable' : 'Enable'">
                      <fa-icon [icon]="['fal', d.enabled ? 'ban' : 'circle-check']" [fixedWidth]="true"></fa-icon>
                    </button>
                    <button class="qbtn" (click)="syncDevice(d)" [disabled]="busy()" title="Sync to sparks">
                      <fa-icon [icon]="['fal', 'arrow-rotate-right']" [fixedWidth]="true"></fa-icon>
                    </button>
                  }
                  @if (sel.kind === 'user' && asUser(sel); as u) {
                    <button class="qbtn" (click)="toggleUser(u)" [disabled]="busy()" [title]="u.enabled ? 'Disable' : 'Enable'">
                      <fa-icon [icon]="['fal', u.enabled ? 'ban' : 'circle-check']" [fixedWidth]="true"></fa-icon>
                    </button>
                  }
                </div>
              }

              <div class="detail-body">
                @for (row of detailRows(sel); track row.label) {
                  <div class="drow">
                    <span class="dlabel">{{ row.label }}</span>
                    <span class="dvalue" [class.mono]="row.mono">{{ row.value }}</span>
                  </div>
                }
              </div>

              @if (actionError()) { <div class="action-error">{{ actionError() }}</div> }

              <!-- Editable fields (Save appears only when modified) + Delete, pinned bottom -->
              @if (sel.kind === 'spark' && asSpark(sel); as s) {
                @if (canManageSpark(s)) {
                  <div class="detail-section">
                    <label class="edit-label">Name</label>
                    <input class="edit-input" [value]="s.name" #snm (input)="0" />
                  </div>
                  <div class="detail-footer">
                    @if (snm.value.trim() && snm.value.trim() !== s.name) {
                      <button class="btn-sm accent" (click)="saveSparkName(s, snm.value)" [disabled]="busy()">Save</button>
                    }
                    <button class="btn-sm danger" (click)="deleteSpark(s)" [disabled]="busy()">Delete</button>
                  </div>
                } @else {
                  <div class="detail-note">You can view this spark but not manage it.</div>
                }
              }

              @if (sel.kind === 'device' && asDevice(sel); as d) {
                @if (canManageDevice(d)) {
                  <div class="detail-footer">
                    <button class="btn-sm danger" (click)="deleteDevice(d)" [disabled]="busy()">Delete</button>
                  </div>
                } @else {
                  <div class="detail-note">You can view this device but not manage it.</div>
                }
              }

              @if (sel.kind === 'user' && asUser(sel); as u) {
                @if (canManageUser(u)) {
                  <div class="detail-footer">
                    <button class="btn-sm danger" (click)="deleteUser(u)" [disabled]="busy()">Delete</button>
                  </div>
                  <div class="detail-note">Role &amp; password are managed on the Users page.</div>
                } @else if (u.isSelf) {
                  <div class="detail-note">This is you.</div>
                }
              }
            </aside>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 1.5rem; height: calc(100vh - 3rem); display: flex; flex-direction: column; }
    .page-head { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
    .page-head h2 { margin: 0; }
    .head-actions { margin-left: auto; }
    .view-pill { padding: 3px 10px; border-radius: 10px; font-size: 0.7rem; font-weight: 600; background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); }
    .state { padding: 2rem; color: var(--text-secondary); display: flex; align-items: center; gap: 0.5rem; }
    .state.error { color: var(--danger, #ef4444); }
    .spin { animation: tspin 1s linear infinite; }
    @keyframes tspin { to { transform: rotate(360deg); } }

    .graph-layout { flex: 1; display: flex; gap: 1rem; min-height: 0; }
    .graph-wrap { flex: 1; position: relative; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background:
      radial-gradient(circle, color-mix(in srgb, var(--text-tertiary) 12%, transparent) 1px, transparent 1px);
      background-size: 22px 22px; cursor: grab; user-select: none; }
    .graph-wrap:active { cursor: grabbing; }
    .graph { display: block; }
    .graph-hint { position: absolute; bottom: 8px; left: 12px; font-size: 0.66rem; color: var(--text-tertiary); pointer-events: none; }

    .edge { stroke: var(--border); stroke-width: 1.5; }
    .gnode { cursor: pointer; }
    .node-circle { fill: var(--bg-surface); stroke: var(--border); stroke-width: 1.5; transition: stroke 0.12s ease; }
    .gnode.root .node-circle { fill: color-mix(in srgb, var(--accent) 16%, var(--bg-surface)); stroke: var(--accent); }
    .gnode.user .node-circle { stroke: color-mix(in srgb, var(--accent) 55%, var(--border)); }
    .gnode.selected .node-circle { stroke: var(--accent); stroke-width: 2.5; }
    .fo-ic { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; font-size: 13px; color: var(--text-secondary); }
    .gnode.root .fo-ic, .gnode.user .fo-ic { color: var(--accent); }
    .nlabel { font-size: 11px; font-weight: 600; fill: var(--text-primary); }
    .sdot { stroke: var(--bg-surface); stroke-width: 1.5; }
    .sdot.online { fill: var(--success, #22c55e); }
    .sdot.warn { fill: var(--warning, #f59e0b); }
    .sdot.offline { fill: var(--text-disabled, #9ca3af); }
    .shared-dot { fill: var(--warning, #f59e0b); }

    .detail-panel { width: 320px; flex-shrink: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-surface); padding: 1rem; overflow-y: auto; }
    .detail-head { display: flex; align-items: center; justify-content: space-between; }
    .detail-title { display: flex; align-items: center; gap: 0.5rem; font-weight: 600; overflow: hidden; }
    .detail-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-kind { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-tertiary); margin: 0.15rem 0 0.9rem; }
    .quickbar { display: flex; gap: 0.4rem; margin: 0 0 1rem; padding-bottom: 0.9rem; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
    .qbtn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 8px; background: var(--bg-input); border: 1px solid var(--border); color: var(--text-secondary); cursor: pointer; transition: all 0.15s ease; }
    .qbtn:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .qbtn:disabled { opacity: 0.5; cursor: not-allowed; }
    .qbtn.danger { color: var(--danger, #ef4444); border-color: color-mix(in srgb, var(--danger, #ef4444) 35%, transparent); }
    .qbtn.danger:hover { background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent); }
    .drow { display: flex; justify-content: space-between; gap: 1rem; padding: 0.4rem 0; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
    .dlabel { font-size: 0.72rem; color: var(--text-tertiary); }
    .dvalue { font-size: 0.75rem; color: var(--text-primary); text-align: right; word-break: break-word; }
    .dvalue.mono { font-family: ui-monospace, monospace; }
    .detail-note { margin-top: 1rem; font-size: 0.68rem; color: var(--text-tertiary); font-style: italic; }
    .action-error { margin-top: 0.8rem; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.72rem; color: var(--danger, #ef4444); background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent); }
    .detail-section { margin-top: 1rem; }
    .edit-label { display: block; font-size: 0.68rem; color: var(--text-tertiary); margin-bottom: 0.3rem; }
    .edit-input { width: 100%; padding: 0.4rem 0.55rem; background: var(--bg-base, var(--bg-surface)); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem; box-sizing: border-box; }
    .detail-footer { display: flex; gap: 0.4rem; margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
    .btn-sm { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.75rem; font-weight: 500; cursor: pointer; border: none; transition: all 0.15s ease; }
    .btn-sm:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-sm.accent { background: var(--accent); color: #fff; }
    .btn-sm.accent:hover { filter: brightness(1.08); }
    .btn-sm.danger { background: var(--bg-input); color: var(--danger, #ef4444); border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 40%, transparent); margin-left: auto; }
    .btn-sm.danger:hover { background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent); }
    .icon-btn { display: inline-flex; padding: 4px; background: transparent; border: none; border-radius: 5px; color: var(--text-tertiary); cursor: pointer; }
    .icon-btn:hover { background: color-mix(in srgb, var(--text-tertiary) 15%, transparent); }
  `],
})
export class TopologyPage implements OnInit {
  private api = inject(ApiService);
  private auth = inject(AuthService);
  private confirm = inject(ConfirmService);

  topology = signal<Topology | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  busy = signal(false);
  actionError = signal<string | null>(null);

  private myEmail = computed(() => this.auth.user()?.email ?? '');

  nodes = signal<GraphNode[]>([]);
  edges = signal<GraphEdge[]>([]);
  selected = signal<GraphNode | null>(null);
  t = signal<{ x: number; y: number; k: number }>({ x: 0, y: 0, k: 1 });

  private posById = computed(() => {
    const m = new Map<string, GraphNode>();
    for (const n of this.nodes()) m.set(n.id, n);
    return m;
  });

  // Pan/drag state.
  private panning = false;
  private dragNode: GraphNode | null = null;
  private last = { x: 0, y: 0 };
  private moved = false;

  async ngOnInit(): Promise<void> {
    try {
      const t = await this.api.get<Topology>('/topology');
      this.topology.set(t);
      this.buildGraph(t);
    } catch {
      this.error.set('Failed to load topology.');
    } finally {
      this.loading.set(false);
    }
  }

  pos(id: string): GraphNode | undefined {
    return this.posById().get(id);
  }

  private buildGraph(t: Topology): void {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const viewLabel = t.view === 'superadmin' ? 'All Users' : 'My Network';
    const root: GraphNode = { id: 'root', kind: 'root', label: viewLabel, sub: '', x: 0, y: TIER_Y.root, data: null };
    nodes.push(root);

    let slot = 0; // leaf column counter, drives x layout bottom-up
    const centerOf = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : slot++ * X_GAP);

    const userXs: number[] = [];
    for (const u of t.users) {
      const uid = 'u:' + u.email;
      const sparkXs: number[] = [];
      for (const s of u.sparks) {
        const sid = 's:' + s.nodeId;
        const devXs: number[] = [];
        for (const d of s.devices) {
          const did = 'd:' + d.deviceId;
          const x = slot++ * X_GAP;
          devXs.push(x);
          nodes.push({ id: did, kind: 'device', label: d.name, sub: d.assignedIp || d.type, status: d.status, x, y: TIER_Y.device, data: d });
          edges.push({ from: sid, to: did });
        }
        const sx = centerOf(devXs);
        sparkXs.push(sx);
        nodes.push({ id: sid, kind: 'spark', label: s.name, sub: s.status, status: s.status, shared: s.shared, x: sx, y: TIER_Y.spark, data: s });
        edges.push({ from: uid, to: sid });
      }
      const ux = centerOf(sparkXs);
      userXs.push(ux);
      nodes.push({ id: uid, kind: 'user', label: u.email, sub: u.role, x: ux, y: TIER_Y.user, data: u });
      edges.push({ from: 'root', to: uid });
    }
    root.x = centerOf(userXs);

    // Center the whole graph in the viewport initially.
    const xs = nodes.map((n) => n.x);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    this.nodes.set(nodes);
    this.edges.set(edges);
    this.t.set({ x: 400 - mid, y: 20, k: 1 });
  }

  // Keep node labels short enough not to overlap neighbours; full value is in the panel.
  trunc(label: string): string {
    return label.length > 20 ? label.slice(0, 19) + '…' : label;
  }

  // ── Interaction ─────────────────────────────────────────────────

  onBgDown(ev: MouseEvent): void {
    this.panning = true;
    this.moved = false;
    this.last = { x: ev.clientX, y: ev.clientY };
  }

  onNodeDown(ev: MouseEvent, n: GraphNode): void {
    ev.stopPropagation();
    this.dragNode = n;
    this.moved = false;
    this.last = { x: ev.clientX, y: ev.clientY };
  }

  @HostListener('document:mousemove', ['$event'])
  onMove(ev: MouseEvent): void {
    if (!this.panning && !this.dragNode) return;
    const dx = ev.clientX - this.last.x;
    const dy = ev.clientY - this.last.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.moved = true;
    this.last = { x: ev.clientX, y: ev.clientY };
    if (this.dragNode) {
      const k = this.t().k;
      const node = this.dragNode;
      this.nodes.update((list) => list.map((x) => (x.id === node.id ? { ...x, x: x.x + dx / k, y: x.y + dy / k } : x)));
      this.dragNode = this.posById().get(node.id) ?? this.dragNode;
    } else if (this.panning) {
      this.t.update((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
    }
  }

  @HostListener('document:mouseup')
  onUp(): void {
    if (this.dragNode && !this.moved) {
      const n = this.dragNode;
      this.selected.set(n.kind === 'root' ? null : n);
    }
    this.panning = false;
    this.dragNode = null;
  }

  onWheel(ev: WheelEvent): void {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 0.9;
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    this.t.update((v) => {
      const k = Math.min(2.5, Math.max(0.3, v.k * factor));
      const scale = k / v.k;
      // Zoom toward the cursor.
      return { k, x: px - (px - v.x) * scale, y: py - (py - v.y) * scale };
    });
  }

  resetView(): void {
    const t = this.topology();
    if (t) this.buildGraph(t);
    this.selected.set(null);
  }

  clearSelection(): void {
    this.selected.set(null);
  }

  // ── Detail panel ─────────────────────────────────────────────────

  detailRows(n: GraphNode): { label: string; value: string; mono?: boolean }[] {
    if (n.kind === 'user') {
      const u = n.data as TUser;
      return [
        { label: 'Email', value: u.email },
        { label: 'Role', value: u.role },
        { label: 'Sparks', value: String(u.sparks.length) },
      ];
    }
    if (n.kind === 'spark') {
      const s = n.data as TSpark;
      return [
        { label: 'Name', value: s.name },
        { label: 'Status', value: s.status },
        { label: 'Adoption', value: s.adoptionStatus },
        { label: 'Owner', value: s.ownerEmail || '—' },
        { label: 'Shared with you', value: s.shared ? 'yes' : 'no' },
        { label: 'Clients', value: String(s.devices.length) },
      ];
    }
    if (n.kind === 'device') {
      const d = n.data as TDevice;
      return [
        { label: 'Name', value: d.name },
        { label: 'Type', value: d.type },
        { label: 'Status', value: d.status },
        { label: 'Address', value: d.assignedIp || '—', mono: true },
        { label: 'Owner', value: d.ownerEmail || '—' },
      ];
    }
    return [];
  }

  // ── Type helpers for the template ────────────────────────────────
  asSpark(n: GraphNode): TSpark { return n.data as TSpark; }
  asDevice(n: GraphNode): TDevice { return n.data as TDevice; }
  asUser(n: GraphNode): TUser { return n.data as TUser; }

  // ── Permissions (backend enforces too; this hides what you can't do) ──
  canManageSpark(s: TSpark): boolean {
    return this.auth.isSuperadmin() || (!!s.ownerEmail && s.ownerEmail === this.myEmail());
  }
  canManageDevice(d: TDevice): boolean {
    return this.auth.isSuperadmin() || (!!d.ownerEmail && d.ownerEmail === this.myEmail());
  }
  canManageUser(u: TUser): boolean {
    return this.auth.isSuperadmin() && !u.isSelf && !!u.username;
  }

  // Whether the selected node has any quick actions the viewer may perform.
  hasQuick(n: GraphNode): boolean {
    if (n.kind === 'spark') return this.canManageSpark(this.asSpark(n));
    if (n.kind === 'device') return this.canManageDevice(this.asDevice(n));
    if (n.kind === 'user') return this.canManageUser(this.asUser(n));
    return false;
  }

  // ── Actions ──────────────────────────────────────────────────────
  private async act(fn: () => Promise<unknown>, keepId: string | null): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.actionError.set(null);
    try {
      await fn();
      await this.reload(keepId ?? undefined);
    } catch {
      this.actionError.set('Action failed — you may not have permission, or the spark is offline.');
    } finally {
      this.busy.set(false);
    }
  }

  // Re-fetch after an action, preserving node positions and the current pan/zoom so the
  // graph doesn't jump, and re-select the same node if it still exists.
  private async reload(keepId?: string): Promise<void> {
    const prevPos = new Map(this.nodes().map((n) => [n.id, { x: n.x, y: n.y }]));
    const prevT = this.t();
    const t = await this.api.get<Topology>('/topology');
    this.topology.set(t);
    this.buildGraph(t);
    this.t.set(prevT);
    this.nodes.update((list) => list.map((n) => { const p = prevPos.get(n.id); return p ? { ...n, x: p.x, y: p.y } : n; }));
    this.selected.set(keepId ? (this.nodes().find((x) => x.id === keepId) ?? null) : null);
  }

  async saveSparkName(s: TSpark, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === s.name) return;
    await this.act(() => this.api.put(`/nodes/${s.nodeId}`, { name: trimmed }), 's:' + s.nodeId);
  }
  async togglePause(s: TSpark): Promise<void> {
    await this.act(() => this.api.post(`/nodes/${s.nodeId}/${s.paused ? 'resume' : 'pause'}`), 's:' + s.nodeId);
  }
  async createVpn(s: TSpark): Promise<void> {
    await this.act(() => this.api.post(`/nodes/${s.nodeId}/create-vpn`), 's:' + s.nodeId);
  }
  async deleteSpark(s: TSpark): Promise<void> {
    const ok = await this.confirm.confirm({ title: 'Delete Spark', message: `Delete "${s.name}"? This cannot be undone.`, confirmLabel: 'Delete', danger: true });
    if (ok) await this.act(() => this.api.delete(`/nodes/${s.nodeId}`), null);
  }
  async toggleDevice(d: TDevice): Promise<void> {
    await this.act(() => this.api.put(`/devices/${d.deviceId}`, { enabled: !d.enabled }), 'd:' + d.deviceId);
  }
  async syncDevice(d: TDevice): Promise<void> {
    await this.act(() => this.api.post(`/devices/${d.deviceId}/sync`), 'd:' + d.deviceId);
  }
  async deleteDevice(d: TDevice): Promise<void> {
    const ok = await this.confirm.confirm({ title: 'Delete Device', message: `Delete "${d.name}"?`, confirmLabel: 'Delete', danger: true });
    if (ok) await this.act(() => this.api.delete(`/devices/${d.deviceId}`), null);
  }
  async toggleUser(u: TUser): Promise<void> {
    await this.act(() => this.api.put(`/users/${u.username}`, { enabled: !u.enabled }), 'u:' + u.email);
  }
  async deleteUser(u: TUser): Promise<void> {
    const ok = await this.confirm.confirm({ title: 'Delete User', message: `Delete user "${u.email}"?`, confirmLabel: 'Delete', danger: true });
    if (ok) await this.act(() => this.api.delete(`/users/${u.username}`), null);
  }

  iconFor(kind: NodeKind): string {
    return kind === 'user' ? 'users' : kind === 'spark' ? 'server' : kind === 'device' ? 'laptop-mobile' : 'sitemap';
  }

  kindLabel(kind: NodeKind): string {
    return kind === 'user' ? 'User' : kind === 'spark' ? 'Spark' : kind === 'device' ? 'Device' : '';
  }

  statusClass(status: string): string {
    if (status === 'online' || status === 'active' || status === 'provisioned') return 'online';
    if (status === 'pending') return 'warn';
    return 'offline';
  }
}
