import { Component, inject, signal, OnInit, OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../services/api.service';

interface VpnConfigResponse {
  readonly configVersion: number;
  readonly server: {
    readonly listenPort?: number;
    readonly address?: string;
    readonly hostAddress?: string;
    readonly dns?: readonly string[];
    readonly mtu?: number;
  };
  readonly defaults: {
    readonly allowedIps?: readonly string[];
    readonly persistentKeepalive?: number;
  };
}

@Component({
  selector: 'app-vpn-config',
  imports: [FormsModule],
  template: `
    <div class="version-badge">Config version {{ configVersion() }}</div>

    <div class="form-grid">
      <div class="form-card">
        <div class="card-header"><h3>Server Settings</h3></div>
        <div class="card-body">
          <div class="field">
            <label>Listen Port</label>
            <input type="number" [(ngModel)]="listenPort" />
          </div>
          <div class="field">
            <label>Address (CIDR)</label>
            <input type="text" [(ngModel)]="address" placeholder="10.0.0.1/24" />
          </div>
          <div class="field">
            <label>Host Address</label>
            <input type="text" [(ngModel)]="hostAddress" placeholder="vpn.example.com" />
          </div>
          <div class="field">
            <label>DNS Servers</label>
            <input type="text" [(ngModel)]="dns" placeholder="1.1.1.1, 8.8.8.8" />
          </div>
          <div class="field">
            <label>MTU</label>
            <input type="number" [(ngModel)]="mtu" />
          </div>
        </div>
      </div>

      <div class="form-card">
        <div class="card-header"><h3>Peer Defaults</h3></div>
        <div class="card-body">
          <div class="field">
            <label>Allowed IPs</label>
            <input type="text" [(ngModel)]="allowedIps" placeholder="0.0.0.0/0, ::/0" />
          </div>
          <div class="field">
            <label>Persistent Keepalive</label>
            <div class="input-suffix">
              <input type="number" [(ngModel)]="keepalive" />
              <span class="suffix">sec</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn-primary" (click)="save()" [disabled]="saving()">
        {{ saving() ? 'Deploying...' : 'Save & Deploy' }}
      </button>
    </div>
  `,
  styles: [`
    .version-badge { display: inline-block; font-size: 0.75rem; color: var(--text-disabled); background: var(--bg-surface); border: 1px solid var(--border); padding: 4px 10px; border-radius: 8px; margin-bottom: 1rem; }
    .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .form-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .card-header { padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--border); }
    .card-header h3 { margin: 0; font-size: 0.875rem; font-weight: 600; color: var(--text-primary); }
    .card-body { padding: 1.25rem; }
    .field { margin-bottom: 1rem; }
    .field:last-child { margin-bottom: 0; }
    label { display: block; font-size: 0.75rem; font-weight: 500; color: var(--text-tertiary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.3px; }
    input { width: 100%; padding: 0.55rem 0.75rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.875rem; box-sizing: border-box; transition: border-color 0.15s ease; }
    input::placeholder { color: var(--text-disabled); }
    input:focus { outline: none; border-color: var(--accent); }
    .input-suffix { position: relative; }
    .input-suffix input { padding-right: 3rem; }
    .suffix { position: absolute; right: 0.75rem; top: 50%; transform: translateY(-50%); font-size: 0.75rem; color: var(--text-disabled); }
    .form-actions { margin-top: 1.25rem; display: flex; justify-content: flex-end; }
    .btn-primary { padding: 0.6rem 1.75rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: 500; transition: background 0.15s ease; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class VpnConfigPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  configVersion = signal(0);
  saving = signal(false);

  listenPort = 51820;
  address = '10.0.0.1/24';
  hostAddress = '';
  dns = '1.1.1.1, 8.8.8.8';
  mtu = 1420;
  allowedIps = '0.0.0.0/0, ::/0';
  keepalive = 25;

  ngOnInit(): void {
    this.fetchConfig();
    this.pollTimer = setInterval(() => this.fetchConfig(), 15000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private async fetchConfig(): Promise<void> {
    try {
      const res = await this.api.get<VpnConfigResponse>('/vpn-config');
      this.configVersion.set(res.configVersion ?? 0);
      if (res.server) {
        if (res.server.listenPort) this.listenPort = res.server.listenPort;
        if (res.server.address) this.address = res.server.address;
        if (res.server.hostAddress) this.hostAddress = res.server.hostAddress;
        if (res.server.dns) this.dns = res.server.dns.join(', ');
        if (res.server.mtu) this.mtu = res.server.mtu;
      }
      if (res.defaults) {
        if (res.defaults.allowedIps) this.allowedIps = res.defaults.allowedIps.join(', ');
        if (res.defaults.persistentKeepalive) this.keepalive = res.defaults.persistentKeepalive;
      }
    } catch {
      // Config may not exist yet
    }
  }

  async save(): Promise<void> {
    this.saving.set(true);
    try {
      await this.api.put('/vpn-config', {
        server: {
          listenPort: this.listenPort,
          address: this.address,
          hostAddress: this.hostAddress,
          dns: this.dns.split(',').map((s) => s.trim()).filter(Boolean),
          mtu: this.mtu,
        },
        defaults: {
          allowedIps: this.allowedIps.split(',').map((s) => s.trim()).filter(Boolean),
          persistentKeepalive: this.keepalive,
        },
      });
      await this.fetchConfig();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      this.saving.set(false);
    }
  }
}
