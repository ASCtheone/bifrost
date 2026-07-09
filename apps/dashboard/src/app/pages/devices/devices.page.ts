import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { environment } from '../../../environments/environment';
import QRCode from 'qrcode';

type DeviceType = 'router' | 'phone' | 'tablet' | 'laptop';

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly status: string;
  readonly assignedIp: string;
  readonly publicKey: string;
  readonly enabled: boolean;
  readonly nodeId: string;
  readonly provisionMethod: string;
  readonly ownerEmail: string | null;
  readonly lastSeen: string | null;
  readonly createdAt: string;
}

interface DevicesResponse {
  readonly devices: readonly DeviceRow[];
}

interface DeviceConfigResponse {
  readonly deviceId: string;
  readonly name: string;
  readonly config: string;
  readonly assignedIp: string;
  readonly provisionToken: string;
}

interface CreateDeviceResponse {
  readonly device: {
    readonly id: string;
    readonly provisionToken: string;
  };
}

const DEVICE_ICONS: Record<DeviceType, string> = {
  router: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="2" y="14" width="20" height="7" rx="2"/><circle cx="7" cy="17.5" r="1"/><circle cx="12" cy="17.5" r="1"/><path d="M12 3v5m-4 2l4-4 4 4"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
  tablet: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M11 18h2"/></svg>`,
  laptop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="28" height="28"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>`,
};

@Component({
  selector: 'app-devices',
  imports: [FormsModule, FaIconComponent],
  template: `
    <div class="page-header">
      <h2>Devices</h2>
      <button class="btn-primary" (click)="showAddDialog.set(true)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14m-7-7h14"/></svg>
        Add Device
      </button>
    </div>

    <!-- Add Device Dialog -->
    @if (showAddDialog()) {
      <div class="overlay" (click)="showAddDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Add Device</h3>
          <div class="field">
            <label>Device Name</label>
            <input type="text" [(ngModel)]="newDevice.name" name="deviceName" placeholder="e.g. Miguel's iPhone" />
          </div>
          <div class="field">
            <label>Type</label>
            <div class="type-selector">
              @for (t of deviceTypes; track t) {
                <button class="type-btn" [class.selected]="newDevice.type === t" (click)="newDevice.type = t">
                  <span class="type-icon" [innerHTML]="getIcon(t)"></span>
                  <span class="type-label">{{ t }}</span>
                </button>
              }
            </div>
          </div>
          @if (addError()) {
            <div class="error-msg">{{ addError() }}</div>
          }
          <div class="dialog-actions">
            <button class="btn-secondary" (click)="showAddDialog.set(false)">Cancel</button>
            <button class="btn-primary" (click)="addDevice()" [disabled]="addingDevice() || !newDevice.name">
              {{ addingDevice() ? 'Creating...' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Provision Dialog -->
    @if (provisionDevice()) {
      <div class="overlay" (click)="provisionDevice.set(null)">
        <div class="dialog provision-dialog" (click)="$event.stopPropagation()">
          <h3>Device Ready</h3>
          <p class="provision-subtitle">Choose how to set up <strong>{{ provisionDevice()!.name }}</strong></p>

          <div class="provision-tabs">
            <button class="ptab" [class.active]="provisionTab() === 'qr'" (click)="provisionTab.set('qr')">QR Code</button>
            <button class="ptab" [class.active]="provisionTab() === 'download'" (click)="provisionTab.set('download')">Download</button>
            <button class="ptab" [class.active]="provisionTab() === 'url'" (click)="provisionTab.set('url')">Share URL</button>
          </div>

          <div class="provision-content">
            @if (provisionTab() === 'qr') {
              <div class="qr-section">
                @if (provisionConfig()) {
                  <div class="qr-placeholder">
                    <img [src]="qrDataUrl()" alt="QR Code" class="qr-image" />
                  </div>
                  <p class="qr-hint">Scan with WireGuard app on the device</p>
                } @else {
                  <div class="qr-loading"><span class="spinner"></span> Generating...</div>
                }
              </div>
            }
            @if (provisionTab() === 'download') {
              <div class="download-section">
                <button class="download-btn" (click)="downloadDeviceConfig()">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-5l5 5 5-5m-5 5V3"/></svg>
                  Download .conf file
                </button>
                <p class="download-hint">Import into WireGuard client on the device</p>
              </div>
            }
            @if (provisionTab() === 'url') {
              <div class="url-section">
                <label class="url-label">Provision link — for the Bifrost app (phone / desktop)</label>
                <div class="url-box">
                  <code>{{ provisionUrl() }}</code>
                  <button class="copy-btn" (click)="copyProvisionUrl()">
                    {{ copied() ? 'Copied!' : 'Copy' }}
                  </button>
                </div>

                <label class="url-label">WireGuard config URL — for routers (GL.iNet → WireGuard Client)</label>
                <div class="url-box">
                  <code>{{ confUrl() }}</code>
                  <button class="copy-btn" (click)="copyConfUrl()">
                    {{ copied() ? 'Copied!' : 'Copy' }}
                  </button>
                </div>
                <p class="url-hint">Returns the raw <code>.conf</code>. In your router's WireGuard client, add a profile from this URL (or use the Download tab and upload the file).</p>
              </div>
            }
          </div>

          <div class="dialog-actions">
            <button class="btn-primary" (click)="provisionDevice.set(null)">Done</button>
          </div>
        </div>
      </div>
    }

    <!-- Assign Device Dialog -->
    @if (assignDeviceId()) {
      <div class="overlay" (click)="assignDeviceId.set(null)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Assign Device</h3>
          <div class="field">
            <label>Select User</label>
            <select [(ngModel)]="assignDeviceEmail" name="assignDeviceUser" class="select-field">
              <option value="">Choose a user...</option>
              @for (user of userListForAssign(); track user.email) {
                <option [value]="user.email">{{ user.displayName || user.email }}</option>
              }
            </select>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" (click)="assignDeviceId.set(null)">Cancel</button>
            <button class="btn-primary" (click)="assignDevice()" [disabled]="!assignDeviceEmail">Assign</button>
          </div>
        </div>
      </div>
    }

    <!-- Device Grid -->
    <div class="device-grid">
      @for (device of devices(); track device.id) {
        <div class="device-card" [class.disabled]="!device.enabled">
          <div class="device-header">
            <div class="device-icon" [innerHTML]="getIcon(device.type)"></div>
            <div class="device-status">
              <span class="status-dot" [class.online]="device.enabled" [class.offline]="!device.enabled"></span>
            </div>
          </div>
          <div class="device-body">
            <div class="device-name">{{ device.name }}</div>
            <code class="device-ip">{{ device.assignedIp }}</code>
            <div class="device-meta">
              <span class="device-type">{{ device.type }}</span>
              <span class="device-status-pill" [attr.data-status]="device.status">{{ device.status }}</span>
            </div>
          </div>
          @if (isSuperadmin()) {
            <div class="device-owner">
              @if (device.ownerEmail) {
                <span class="owner-tag">{{ device.ownerEmail.split('@')[0] }}</span>
                <button class="owner-x" (click)="unassignDevice(device)" title="Unassign">×</button>
              } @else {
                <button class="assign-device-btn" (click)="showDeviceAssign(device.id)">
                  <fa-icon [icon]="['fal', 'user-plus']" [fixedWidth]="true"></fa-icon> Assign
                </button>
              }
            </div>
          }
          @if (device.status === 'pending') {
            <button class="sync-btn" (click)="syncDevice(device)" [disabled]="syncingDeviceId() === device.id" title="Create peer on all sparks">
              @if (syncingDeviceId() === device.id) {
                <span class="spinner-sm"></span> Syncing...
              } @else {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                Sync to sparks
              }
            </button>
          }
          <div class="device-footer">
            <button class="action-btn" (click)="toggleDevice(device)" [title]="device.enabled ? 'Disable' : 'Enable'">
              @if (device.enabled) {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M18.36 6.64A9 9 0 015.64 18.36M5.64 5.64A9 9 0 0118.36 18.36M1 1l22 22"/></svg>
              } @else {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
              }
            </button>
            <button class="action-btn" (click)="downloadConfig(device)" title="Download WireGuard config">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-5l5 5 5-5m-5 5V3"/></svg>
            </button>
            <button class="action-btn danger" (click)="removeDevice(device)" title="Delete device">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
            </button>
          </div>
        </div>
      }
      @if (devices().length === 0 && !loading()) {
        <div class="empty-card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" width="48" height="48"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/></svg>
          <p>No devices yet</p>
          <span>Add a device to generate its VPN configuration</span>
        </div>
      }
    </div>
  `,
  styles: [`
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; }
    .page-header h2 { margin: 0; font-size: 1.1rem; color: var(--text-primary); font-weight: 600; }
    .btn-primary { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: background 0.15s ease; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { padding: 0.5rem 1rem; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.8rem; }

    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; }
    .dialog { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; width: 420px; }
    .dialog h3 { margin: 0 0 1rem; color: var(--text-primary); font-size: 1rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.3px; }
    .field input { width: 100%; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; box-sizing: border-box; }
    .field input:focus { outline: none; border-color: var(--accent); }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

    .type-selector { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; }
    .type-btn { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; padding: 0.75rem 0.5rem; background: var(--bg-input); border: 2px solid var(--border); border-radius: 10px; cursor: pointer; transition: all 0.15s ease; color: var(--text-disabled); }
    .type-btn:hover { border-color: var(--text-tertiary); color: var(--text-secondary); }
    .type-btn.selected { border-color: var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .type-icon { display: flex; align-items: center; justify-content: center; }
    .type-label { font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }

    .device-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; }
    .device-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem; display: flex; flex-direction: column; transition: all 0.15s ease; }
    .device-card:hover { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .device-card.disabled { opacity: 0.5; }
    .device-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }
    .device-icon { color: var(--text-tertiary); }
    .device-status { display: flex; align-items: center; }
    .status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .status-dot.online { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.offline { background: var(--text-disabled); }
    .device-body { flex: 1; margin-bottom: 0.75rem; }
    .device-name { font-weight: 600; font-size: 0.9rem; color: var(--text-primary); margin-bottom: 0.25rem; }
    .device-ip { display: inline-block; padding: 2px 8px; border-radius: 6px; background: var(--bg-input); font-size: 0.75rem; font-family: monospace; color: var(--text-secondary); margin-bottom: 0.25rem; }
    .device-meta { display: flex; align-items: center; gap: 0.4rem; }
    .device-type { font-size: 0.65rem; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.3px; font-weight: 500; }
    .device-status-pill { font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; padding: 1px 6px; border-radius: 6px; }
    .device-status-pill[data-status="pending"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }
    .device-status-pill[data-status="provisioned"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .device-status-pill[data-status="active"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .device-status-pill[data-status="revoked"] { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); }
    .device-owner { display: flex; align-items: center; gap: 0.25rem; margin-bottom: 0.4rem; }
    .owner-tag { font-size: 0.6rem; color: var(--text-disabled); background: var(--bg-input); padding: 2px 8px; border-radius: 6px; }
    .owner-x { background: none; border: none; color: var(--text-disabled); cursor: pointer; font-size: 0.75rem; padding: 0 4px; border-radius: 4px; transition: all 0.15s ease; }
    .owner-x:hover { color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
    .assign-device-btn { display: inline-flex; align-items: center; gap: 0.25rem; padding: 2px 8px; background: none; border: 1px dashed var(--text-disabled); color: var(--text-disabled); border-radius: 6px; cursor: pointer; font-size: 0.6rem; transition: all 0.15s ease; }
    .assign-device-btn:hover { border-color: var(--accent); color: var(--accent); }
    .select-field { width: 100%; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; }
    .select-field:focus { outline: none; border-color: var(--accent); }
    .sync-btn { display: flex; align-items: center; justify-content: center; gap: 0.3rem; width: 100%; padding: 0.4rem; background: color-mix(in srgb, var(--warning, #f59e0b) 10%, transparent); border: 1px solid color-mix(in srgb, var(--warning, #f59e0b) 30%, transparent); border-radius: 6px; color: var(--warning, #f59e0b); font-size: 0.7rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; margin-bottom: 0.5rem; }
    .sync-btn:hover { background: color-mix(in srgb, var(--warning, #f59e0b) 20%, transparent); border-color: var(--warning, #f59e0b); }
    .sync-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .spinner-sm { display: inline-block; width: 10px; height: 10px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    .device-footer { display: flex; gap: 4px; border-top: 1px solid var(--border); padding-top: 0.6rem; }
    .action-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: none; border: 1px solid var(--border); color: var(--text-tertiary); border-radius: 6px; cursor: pointer; transition: all 0.15s ease; }
    .action-btn:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .action-btn.danger:hover { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); border-color: var(--error); }

    .provision-dialog { width: 460px; }
    .provision-subtitle { font-size: 0.8rem; color: var(--text-secondary); margin: 0 0 1rem; }
    .provision-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); margin-bottom: 1rem; }
    .ptab { padding: 0.5rem 1rem; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-disabled); font-size: 0.8rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
    .ptab:hover { color: var(--text-secondary); }
    .ptab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .provision-content { min-height: 180px; display: flex; align-items: center; justify-content: center; }
    .qr-section { text-align: center; }
    .qr-placeholder { background: #fff; padding: 1rem; border-radius: 12px; display: inline-block; }
    .qr-image { width: 200px; height: 200px; image-rendering: pixelated; }
    .qr-hint { font-size: 0.75rem; color: var(--text-disabled); margin: 0.75rem 0 0; }
    .qr-loading { display: flex; align-items: center; gap: 0.5rem; color: var(--text-disabled); font-size: 0.85rem; }
    .download-section { text-align: center; width: 100%; }
    .download-btn { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; width: 100%; padding: 1.5rem; background: color-mix(in srgb, var(--accent) 8%, transparent); border: 2px dashed color-mix(in srgb, var(--accent) 40%, transparent); border-radius: 12px; color: var(--accent); font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
    .download-btn:hover { background: color-mix(in srgb, var(--accent) 15%, transparent); border-color: var(--accent); }
    .download-hint { font-size: 0.75rem; color: var(--text-disabled); margin: 0.75rem 0 0; }
    .url-section { width: 100%; }
    .url-label { display: block; font-size: 0.7rem; color: var(--text-tertiary); margin: 0.75rem 0 0.35rem; }
    .url-label:first-child { margin-top: 0; }
    .url-box { display: flex; align-items: center; gap: 0.5rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 0.5rem 0.75rem; margin-bottom: 0.25rem; }
    .url-box code { flex: 1; font-size: 0.7rem; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .copy-btn { padding: 0.3rem 0.75rem; background: var(--accent); color: #fff; border: none; border-radius: 6px; font-size: 0.7rem; font-weight: 500; cursor: pointer; white-space: nowrap; }
    .url-hint { font-size: 0.75rem; color: var(--text-disabled); margin: 0.75rem 0 0; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .empty-card { grid-column: 1 / -1; display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 3rem; color: var(--text-disabled); background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; }
    .empty-card p { margin: 0; font-size: 0.9rem; font-weight: 500; }
    .empty-card span { font-size: 0.75rem; }
  `],
})
export class DevicesPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly confirmSvc = inject(ConfirmService);

  devices = signal<DeviceRow[]>([]);
  loading = signal(true);
  showAddDialog = signal(false);
  addingDevice = signal(false);
  addError = signal('');
  deviceTypes: DeviceType[] = ['laptop', 'phone', 'tablet', 'router'];
  newDevice = { name: '', type: 'laptop' as DeviceType };

  syncingDeviceId = signal<string | null>(null);
  assignDeviceId = signal<string | null>(null);
  assignDeviceEmail = '';
  userListForAssign = signal<{ email: string; displayName: string }[]>([]);

  // Provision dialog
  provisionDevice = signal<{ id: string; name: string; token: string } | null>(null);
  provisionTab = signal<'qr' | 'download' | 'url'>('qr');
  provisionConfig = signal<string | null>(null);
  qrDataUrl = signal('');
  copied = signal(false);

  ngOnInit(): void {
    this.fetchDevices();
  }

  getIcon(type: DeviceType): string {
    return DEVICE_ICONS[type];
  }

  private async fetchDevices(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.get<DevicesResponse>('/devices');
      this.devices.set([...res.devices]);
    } catch (err) {
      console.error('[devices] fetch failed:', err);
    } finally {
      this.loading.set(false);
    }
  }

  async addDevice(): Promise<void> {
    this.addError.set('');
    this.addingDevice.set(true);
    try {
      const res = await this.api.post<CreateDeviceResponse>('/devices', {
        name: this.newDevice.name,
        type: this.newDevice.type,
      });
      this.showAddDialog.set(false);
      this.newDevice = { name: '', type: 'laptop' };
      await this.fetchDevices();

      // Open provision dialog
      this.openProvision(res.device.id, this.devices().find(d => d.id === res.device.id)?.name ?? '', res.device.provisionToken);
    } catch (err) {
      this.addError.set(err instanceof Error ? err.message : 'Failed to create device');
    } finally {
      this.addingDevice.set(false);
    }
  }

  async openProvision(deviceId: string, name: string, token: string): Promise<void> {
    this.provisionDevice.set({ id: deviceId, name, token });
    this.provisionTab.set('qr');
    this.provisionConfig.set(null);
    this.copied.set(false);

    // Fetch the WireGuard config
    try {
      const res = await this.api.get<DeviceConfigResponse>(`/devices/${deviceId}/config`);
      this.provisionConfig.set(res.config);
      this.generateQr();
    } catch (err) {
      console.error('[devices] config fetch failed:', err);
    }
  }

  provisionUrl(): string {
    const token = this.provisionDevice()?.token;
    return token ? `${environment.apiUrl}/provision/${token}` : '';
  }

  /** Direct WireGuard .conf URL — for routers (e.g. GL.iNet) and WireGuard import. */
  confUrl(): string {
    const token = this.provisionDevice()?.token;
    return token ? `${environment.apiUrl}/wg/${token}` : '';
  }

  /** Generate the QR locally from the actual WireGuard config (scannable by the
   *  WireGuard app). Never sent to a third party — the config is a secret. */
  async generateQr(): Promise<void> {
    const config = this.provisionConfig();
    if (!config) return;
    try {
      const dataUrl = await QRCode.toDataURL(config, { width: 240, margin: 1 });
      this.qrDataUrl.set(dataUrl);
    } catch (err) {
      console.error('[devices] QR generation failed:', err);
    }
  }

  async copyConfUrl(): Promise<void> {
    await navigator.clipboard.writeText(this.confUrl());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  async downloadDeviceConfig(): Promise<void> {
    const config = this.provisionConfig();
    const device = this.provisionDevice();
    if (!config || !device) return;

    const blob = new Blob([config], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${device.name.replace(/[^a-zA-Z0-9-_]/g, '_')}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async copyProvisionUrl(): Promise<void> {
    await navigator.clipboard.writeText(this.provisionUrl());
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  isSuperadmin(): boolean {
    return this.auth.isSuperadmin();
  }

  async showDeviceAssign(deviceId: string): Promise<void> {
    try {
      const res = await this.api.get<{ users: { email: string; displayName: string }[] }>('/users');
      this.userListForAssign.set(res.users);
    } catch { /* ignore */ }
    this.assignDeviceEmail = '';
    this.assignDeviceId.set(deviceId);
  }

  async assignDevice(): Promise<void> {
    const deviceId = this.assignDeviceId();
    if (!deviceId || !this.assignDeviceEmail) return;
    try {
      await this.api.put(`/devices/${deviceId}`, { ownerEmail: this.assignDeviceEmail });
      this.assignDeviceId.set(null);
      await this.fetchDevices();
    } catch (err) {
      console.error('[devices] assign failed:', err);
    }
  }

  async unassignDevice(device: DeviceRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Unassign Device',
      message: `Remove owner from "${device.name}"?`,
      confirmLabel: 'Unassign',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.put(`/devices/${device.id}`, { ownerEmail: null });
      await this.fetchDevices();
    } catch (err) {
      console.error('[devices] unassign failed:', err);
    }
  }

  async syncDevice(device: DeviceRow): Promise<void> {
    if (this.syncingDeviceId()) return;
    this.syncingDeviceId.set(device.id);
    try {
      await this.api.post(`/devices/${device.id}/sync`);
      await this.fetchDevices();
    } catch (err) {
      console.error('[devices] sync failed:', err);
    } finally {
      this.syncingDeviceId.set(null);
    }
  }

  async toggleDevice(device: DeviceRow): Promise<void> {
    try {
      await this.api.put(`/devices/${device.id}`, { enabled: !device.enabled });
      await this.fetchDevices();
    } catch (err) {
      console.error('[devices] toggle failed:', err);
    }
  }

  async downloadConfig(device: DeviceRow): Promise<void> {
    try {
      const res = await this.api.get<DeviceConfigResponse>(`/devices/${device.id}/config`);
      this.openProvision(device.id, device.name, res.provisionToken);
    } catch (err) {
      console.error('[devices] config fetch failed:', err);
    }
  }

  async removeDevice(device: DeviceRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete Device',
      message: `Delete device "${device.name}"? The VPN config will stop working.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.api.delete(`/devices/${device.id}`);
      await this.fetchDevices();
    } catch (err) {
      console.error('[devices] remove failed:', err);
    }
  }
}
