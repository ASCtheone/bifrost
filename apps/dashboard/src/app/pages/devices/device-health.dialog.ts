import { Component, inject, input, output, signal, OnInit } from '@angular/core';
import { ApiService } from '../../services/api.service';

type HealthStatus = 'ok' | 'warn' | 'fail';

interface HealthCheck {
  readonly id: string;
  readonly status: HealthStatus;
  readonly message: string;
}

interface NodeHealth {
  readonly nodeId: string;
  readonly nodeName: string;
  readonly role: string;
  readonly endpoint: string | null;
  readonly status: HealthStatus;
  readonly checks: readonly HealthCheck[];
}

interface DeviceHealth {
  readonly deviceId: string;
  readonly status: HealthStatus;
  readonly healthyNodes: number;
  readonly checks: readonly HealthCheck[];
  readonly nodes: readonly NodeHealth[];
  readonly checkedAt: string;
}

const STATUS_LABEL: Record<HealthStatus, string> = { ok: 'OK', warn: 'Warning', fail: 'Failing' };

/**
 * Connection health for one device: can the router get a tunnel to each of its
 * sparks? Shows the control plane's per-spark checks plus the router's own
 * reported handshake results (GET /devices/:id/health).
 */
@Component({
  selector: 'app-device-health-dialog',
  template: `
    <div class="overlay" (click)="closed.emit()">
      <div class="dialog health-dialog" (click)="$event.stopPropagation()" role="dialog" aria-labelledby="health-title">
        <div class="health-head">
          <h3 id="health-title">Connection health · {{ deviceName() }}</h3>
          <button class="refresh-btn" (click)="load()" [disabled]="loading()" title="Run the checks again">
            {{ loading() ? 'Checking…' : 'Re-check' }}
          </button>
        </div>

        @if (error()) {
          <div class="error-msg">{{ error() }}</div>
        }

        @if (health(); as h) {
          <div class="summary" [attr.data-status]="h.status">
            <span class="summary-status">{{ statusLabel(h.status) }}</span>
            <span class="summary-text">{{ h.healthyNodes }} of {{ h.nodes.length }} spark{{ h.nodes.length === 1 ? '' : 's' }} reachable</span>
          </div>

          <ul class="checks">
            @for (c of h.checks; track c.id) {
              <li [attr.data-status]="c.status"><span class="dot"></span>{{ c.message }}</li>
            }
          </ul>

          @for (n of h.nodes; track n.nodeId) {
            <section class="node" [attr.data-status]="n.status">
              <header>
                <span class="node-name">{{ n.nodeName }}</span>
                @if (n.role) { <span class="node-role">{{ n.role }}</span> }
                @if (n.endpoint) { <code class="node-ep">{{ n.endpoint }}</code> }
                <span class="node-status">{{ statusLabel(n.status) }}</span>
              </header>
              <ul class="checks">
                @for (c of n.checks; track c.id) {
                  <li [attr.data-status]="c.status"><span class="dot"></span>{{ c.message }}</li>
                }
              </ul>
            </section>
          }

          <p class="hint">
            Checked {{ h.checkedAt }}. The router's own results arrive with its next poll —
            run <code>bifrost check</code> on the router to test every spark now.
          </p>
        } @else if (loading()) {
          <p class="hint">Running checks…</p>
        }

        <div class="dialog-actions">
          <button class="btn-primary" (click)="closed.emit()">Close</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; padding: 16px; }
    .dialog { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; width: 560px; max-width: 100%; max-height: 85vh; overflow-y: auto; box-sizing: border-box; }
    .health-head { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
    .health-head h3 { margin: 0; color: var(--text-primary); font-size: 1rem; }
    .refresh-btn { padding: 0.35rem 0.8rem; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.75rem; white-space: nowrap; }
    .refresh-btn:disabled { opacity: 0.6; cursor: default; }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }

    [data-status="ok"] { --tone: var(--success); }
    [data-status="warn"] { --tone: var(--warning); }
    [data-status="fail"] { --tone: var(--error); }

    .summary { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.65rem 0.85rem; border-radius: 10px; margin-bottom: 0.75rem; background: color-mix(in srgb, var(--tone) 10%, transparent); border: 1px solid color-mix(in srgb, var(--tone) 35%, transparent); }
    .summary-status { font-weight: 700; font-size: 0.85rem; color: var(--tone); }
    .summary-text { font-size: 0.8rem; color: var(--text-secondary); }

    .checks { list-style: none; margin: 0 0 0.75rem; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
    .checks li { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.78rem; line-height: 1.4; color: var(--text-secondary); }
    .checks li[data-status="fail"] { color: var(--text-primary); }
    .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); transform: translateY(-1px); }

    .node { border: 1px solid var(--border); border-left: 3px solid var(--tone); border-radius: 10px; padding: 0.7rem 0.85rem 0.1rem; margin-bottom: 0.6rem; }
    .node header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; margin-bottom: 0.5rem; }
    .node-name { font-weight: 600; font-size: 0.85rem; color: var(--text-primary); }
    .node-role { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.3px; color: var(--text-disabled); font-weight: 600; }
    .node-ep { font-size: 0.7rem; padding: 1px 6px; border-radius: 5px; background: var(--bg-input); color: var(--text-secondary); }
    .node-status { margin-left: auto; font-size: 0.7rem; font-weight: 700; color: var(--tone); }

    .hint { font-size: 0.72rem; color: var(--text-tertiary); margin: 0.25rem 0 1rem; }
    .hint code { font-size: 0.7rem; }
    .dialog-actions { display: flex; justify-content: flex-end; }
    .btn-primary { padding: 0.5rem 1rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.8rem; font-weight: 500; }
  `],
})
export class DeviceHealthDialog implements OnInit {
  private readonly api = inject(ApiService);

  readonly deviceId = input.required<string>();
  readonly deviceName = input<string>('');
  readonly closed = output<void>();

  readonly health = signal<DeviceHealth | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  ngOnInit(): void {
    this.load();
  }

  statusLabel(s: HealthStatus): string {
    return STATUS_LABEL[s];
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try {
      this.health.set(await this.api.get<DeviceHealth>(`/devices/${encodeURIComponent(this.deviceId())}/health`));
    } catch (err) {
      console.error('[device-health] fetch failed:', err);
      this.error.set('Could not run the health check. Try again in a moment.');
    } finally {
      this.loading.set(false);
    }
  }
}
