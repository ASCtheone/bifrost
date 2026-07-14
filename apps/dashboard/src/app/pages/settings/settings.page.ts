import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { ThemeService, type ThemeMode } from '../../services/theme.service';
import { environment } from '../../../environments/environment';

/**
 * Account and appearance settings, plus the build the control plane is running.
 *
 * The account menu has always linked here, but the route didn't exist — so the
 * router's `**` fallback silently redirected to the public landing page.
 */
@Component({
  selector: 'app-settings',
  imports: [RouterLink],
  template: `
    <div class="settings-page">
      <div class="form-grid">
        <div class="form-card">
          <div class="card-header"><h3>Account</h3></div>
          <div class="card-body">
            <div class="row">
              <span class="key">Signed in as</span>
              <span class="val">{{ email() }}</span>
            </div>
            <div class="row">
              <span class="key">Role</span>
              <span class="val">{{ role() }}</span>
            </div>
            <a class="btn" routerLink="/change-password">Change password</a>
          </div>
        </div>

        <div class="form-card">
          <div class="card-header"><h3>Appearance</h3></div>
          <div class="card-body">
            <span class="key">Theme</span>
            <div class="themes">
              @for (m of modes; track m) {
                <button
                  class="theme-btn"
                  [class.active]="theme.mode() === m"
                  (click)="theme.setMode(m)"
                >
                  {{ m }}
                </button>
              }
            </div>
          </div>
        </div>
      </div>

      <!-- Build of the control plane. Every component shares one version, so this
           is the version of the whole deployment, not just the dashboard. -->
      <footer class="version">
        @if (version()) {
          Bifrost v{{ version() }}
        } @else {
          <span class="dim">version unavailable — could not reach the control plane</span>
        }
      </footer>
    </div>
  `,
  styles: [`
    .settings-page { display: flex; flex-direction: column; min-height: calc(100vh - 8rem); }
    .form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.25rem; }
    .form-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    .card-header { padding: 0.85rem 1.25rem; border-bottom: 1px solid var(--border); }
    .card-header h3 { margin: 0; font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .card-body { padding: 1.25rem; }
    .row { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; padding: 0.5rem 0; border-bottom: 1px solid var(--border); }
    .row:last-of-type { border-bottom: none; }
    .key { font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.3px; }
    .val { font-size: 0.9rem; color: var(--text-primary); overflow-wrap: anywhere; }
    .btn { display: inline-block; margin-top: 1rem; padding: 0.55rem 0.9rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; text-decoration: none; cursor: pointer; transition: border-color 0.15s ease; }
    .btn:hover { border-color: var(--accent); }
    .themes { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
    .theme-btn { flex: 1; padding: 0.55rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary, var(--text-primary)); font-size: 0.85rem; text-transform: capitalize; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
    .theme-btn:hover { border-color: var(--accent); }
    .theme-btn.active { border-color: var(--accent); color: var(--accent); }

    /* Bottom middle, pinned below the content rather than floating over it. */
    .version { margin-top: auto; padding-top: 2.5rem; text-align: center; font-size: 0.75rem; color: var(--text-disabled); }
    .dim { opacity: 0.8; }
  `],
})
export class SettingsPage implements OnInit {
  private readonly auth = inject(AuthService);
  readonly theme = inject(ThemeService);

  readonly modes: readonly ThemeMode[] = ['light', 'dark', 'system'];
  readonly email = signal('');
  readonly role = signal('');
  readonly version = signal('');

  ngOnInit(): void {
    const user = this.auth.user();
    this.email.set(user?.email ?? '');
    this.role.set(this.auth.isAdmin() ? 'Administrator' : 'User');

    // The control plane reports the version all components share. A failure here
    // is not worth an error banner on a settings page — the footer just says so.
    fetch(`${environment.apiUrl}/health`)
      .then((r) => r.json())
      .then((d: { version?: string }) => this.version.set(d?.version ?? ''))
      .catch(() => this.version.set(''));
  }
}
