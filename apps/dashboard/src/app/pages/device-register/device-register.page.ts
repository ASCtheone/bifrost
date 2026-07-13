import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';
import { ApiService } from '../../services/api.service';

/**
 * Device pairing. A device (GL.iNet router) shows a code and links here as
 * `/device/register?deviceCode=XXXX-XXXX&callback=<router-url>`. The signed-in
 * user confirms → the device is tied to their account → the browser is redirected
 * to the router's callback carrying the provision token (the router saves it).
 * If the visitor isn't signed in, they're sent to /login and returned here.
 */
@Component({
  selector: 'app-device-register',
  imports: [FormsModule],
  template: `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-brand">
          <img src="logo.png" alt="Bifrost" class="auth-logo" />
          <h1>BIFROST</h1>
          <p class="auth-subtitle">Register a device</p>
        </div>

        @if (done()) {
          <div class="done">
            <div class="ok-icon">✓</div>
            <p class="done-title">{{ deviceName() }} is registered</p>
            @if (callback()) {
              <p class="done-sub">Returning to your router to finish connecting…</p>
            } @else {
              <p class="done-sub">Enter this token on the device to connect it:</p>
              <div class="token-box">{{ token() }}</div>
            }
          </div>
        } @else {
          <form (ngSubmit)="submit()">
            <div class="field">
              <label>Device code</label>
              <input type="text" [(ngModel)]="code" name="code" placeholder="XXXX-XXXX"
                     autocapitalize="characters" (ngModelChange)="upper($event)" required />
              <span class="field-hint">Shown on the device's setup page.</span>
            </div>
            <div class="field">
              <label>Name <span class="opt">(optional)</span></label>
              <input type="text" [(ngModel)]="name" name="name" placeholder="e.g. Home Router" />
            </div>
            <div class="field">
              <label>Registration expires</label>
              <select [(ngModel)]="expiresInDays" name="expiresInDays" class="select-field">
                <option [ngValue]="0">Never</option>
                <option [ngValue]="7">In 7 days</option>
                <option [ngValue]="30">In 30 days</option>
                <option [ngValue]="90">In 90 days</option>
                <option [ngValue]="365">In 1 year</option>
              </select>
              <span class="field-hint">You can reset this later from Devices.</span>
            </div>
            @if (error()) {
              <div class="error-msg">{{ error() }}</div>
            }
            <button type="submit" class="btn-auth" [disabled]="loading() || !code.trim()">
              {{ loading() ? 'Registering…' : 'Register device' }}
            </button>
          </form>
        }
      </div>
    </div>
  `,
  styles: [`
    .auth-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; background: var(--bg-secondary); padding: 2rem 0; }
    .auth-card { background: var(--bg-surface); padding: 2.5rem; border-radius: 16px; width: 380px; border: 1px solid var(--border); }
    .auth-brand { display: flex; flex-direction: column; align-items: center; margin-bottom: 1.75rem; }
    .auth-logo { width: 56px; height: 56px; margin-bottom: 0.75rem; }
    h1 { margin: 0; font-family: 'Audiowide', sans-serif; font-size: 1.2rem; color: var(--text-tertiary); letter-spacing: 2px; text-shadow: 0 2px 4px rgba(0,0,0,0.5); }
    .auth-subtitle { margin: 0.5rem 0 0; font-size: 0.8rem; color: var(--text-tertiary); }
    .field { margin-bottom: 1rem; }
    label { display: block; font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.3px; }
    label .opt { text-transform: none; color: var(--text-disabled); }
    input, .select-field { width: 100%; padding: 0.65rem 0.85rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.9rem; box-sizing: border-box; }
    input::placeholder { color: var(--text-disabled); }
    input:focus, .select-field:focus { outline: none; border-color: var(--accent); }
    input[name="code"] { font-family: var(--font-num, monospace); letter-spacing: 2px; text-transform: uppercase; }
    .field-hint { display: block; font-size: 0.65rem; color: var(--text-disabled); margin-top: 0.25rem; }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .btn-auth { width: 100%; padding: 0.7rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; }
    .btn-auth:hover { background: var(--accent-hover); }
    .btn-auth:disabled { opacity: 0.5; cursor: not-allowed; }
    .done { text-align: center; }
    .ok-icon { width: 48px; height: 48px; margin: 0 auto 0.75rem; border-radius: 50%; background: color-mix(in srgb, var(--success, #16a34a) 15%, transparent); color: var(--success, #16a34a); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }
    .done-title { font-size: 0.95rem; color: var(--text-primary); font-weight: 600; margin: 0 0 0.35rem; }
    .done-sub { font-size: 0.8rem; color: var(--text-tertiary); margin: 0 0 0.75rem; }
    .token-box { font-family: var(--font-num, monospace); font-size: 0.85rem; word-break: break-all; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; padding: 0.6rem 0.75rem; color: var(--text-primary); }
  `],
})
export class DeviceRegisterPage implements OnInit {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  code = '';
  name = '';
  expiresInDays = 0;
  error = signal('');
  loading = signal(false);
  done = signal(false);
  token = signal('');
  deviceName = signal('');
  callback = signal('');

  ngOnInit(): void {
    const qp = this.route.snapshot.queryParamMap;
    this.code = (qp.get('deviceCode') ?? '').toUpperCase();

    // Must be signed in to tie a device to an account.
    if (!this.auth.isLoggedIn()) {
      const returnUrl = this.router.url; // preserves the deviceCode query
      void this.router.navigate(['/login'], { queryParams: { returnUrl } });
    }
  }

  /** A callback must target a private/LAN address (defense-in-depth; the server
   *  already dropped non-private callbacks when the code was created). */
  private isPrivateCallback(url: string): boolean {
    let h: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      h = u.hostname;
    } catch {
      return false;
    }
    if (h === 'localhost' || h === '::1') return true;
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
      const a = +m[1], b = +m[2];
      return a === 10 || a === 127 || a === 169 && b === 254
        || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
    }
    return /^f[cd][0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h); // IPv6 ULA / link-local
  }

  upper(value: string): void {
    this.code = value.toUpperCase();
  }

  async submit(): Promise<void> {
    this.error.set('');
    this.loading.set(true);
    try {
      const res = await this.api.post<{
        provisionToken: string; name: string; deviceId: string; callbackUrl: string | null;
      }>('/device/register', {
        deviceCode: this.code.trim(),
        name: this.name.trim() || undefined,
        expiresInDays: this.expiresInDays || undefined,
      });
      this.token.set(res.provisionToken);
      this.deviceName.set(res.name);

      // Hand the token back to the device via the callback it registered with —
      // server-validated as private/LAN, and re-checked here. Otherwise the user
      // enters the token on the device manually.
      const cb = res.callbackUrl ?? '';
      if (cb && this.isPrivateCallback(cb)) {
        this.callback.set(cb);
        const sep = cb.includes('?') ? '&' : '?';
        const url = `${cb}${sep}action=token&token=${encodeURIComponent(res.provisionToken)}`
          + `&deviceId=${encodeURIComponent(res.deviceId)}&name=${encodeURIComponent(res.name)}`;
        setTimeout(() => { window.location.href = url; }, 1200);
      }
      this.done.set(true);
    } catch (err) {
      this.error.set((err as { message?: string }).message ?? 'Registration failed');
    } finally {
      this.loading.set(false);
    }
  }
}
