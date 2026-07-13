import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

/**
 * Password change screen. Reached automatically right after signing in with a
 * temporary password (the admin hands new users a temp password), and usable
 * for self-service changes. Requires the current password.
 */
@Component({
  selector: 'app-change-password',
  imports: [FormsModule],
  template: `
    <div class="auth-container">
      <div class="auth-card">
        <div class="auth-brand">
          <img src="logo.png" alt="Bifrost" class="auth-logo" />
          <h1>BIFROST</h1>
          <p class="auth-subtitle">Choose a new password</p>
        </div>
        <form (ngSubmit)="submit()">
          <div class="field">
            <label>Current Password</label>
            <input type="password" [(ngModel)]="current" name="current" placeholder="Temporary or current password" required />
          </div>
          <div class="field">
            <label>New Password</label>
            <input type="password" [(ngModel)]="next" name="next" placeholder="Choose a new password" required />
          </div>
          <div class="field">
            <label>Confirm New Password</label>
            <input type="password" [(ngModel)]="confirm" name="confirm" placeholder="Re-enter new password" required />
          </div>
          <ul class="rules">
            @for (r of rules; track r.label) {
              <li [class.ok]="r.met">{{ r.met ? '✓' : '•' }} {{ r.label }}</li>
            }
          </ul>
          @if (error()) {
            <div class="error-msg">{{ error() }}</div>
          }
          <button type="submit" class="btn-auth" [disabled]="loading() || !valid">
            {{ loading() ? 'Updating…' : 'Update password' }}
          </button>
        </form>
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
    input { width: 100%; padding: 0.65rem 0.85rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.9rem; box-sizing: border-box; transition: border-color 0.15s ease; }
    input::placeholder { color: var(--text-disabled); }
    input:focus { outline: none; border-color: var(--accent); }
    .rules { list-style: none; padding: 0; margin: 0 0 1rem; display: grid; grid-template-columns: 1fr 1fr; gap: 0.15rem 0.75rem; }
    .rules li { font-size: 0.72rem; color: var(--text-disabled); }
    .rules li.ok { color: var(--success, #16a34a); }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .btn-auth { width: 100%; padding: 0.7rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 500; transition: background 0.15s ease; }
    .btn-auth:hover { background: var(--accent-hover); }
    .btn-auth:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class ChangePasswordPage {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  // Pre-filled when arriving from an invite/reset link (login carries the temp
  // password across in router state) so the user doesn't have to re-type it.
  current = (history.state?.['current'] as string) ?? '';
  next = '';
  confirm = '';
  error = signal('');
  loading = signal(false);

  get rules() {
    const p = this.next;
    return [
      { label: '12+ characters', met: p.length >= 12 },
      { label: 'Uppercase letter', met: /[A-Z]/.test(p) },
      { label: 'Lowercase letter', met: /[a-z]/.test(p) },
      { label: 'A number', met: /[0-9]/.test(p) },
    ];
  }

  get valid() {
    return !!this.current && this.rules.every((r) => r.met) && this.next === this.confirm;
  }

  async submit(): Promise<void> {
    this.error.set('');
    if (this.next !== this.confirm) {
      this.error.set('Passwords do not match');
      return;
    }
    this.loading.set(true);
    try {
      await this.authService.changePassword(this.current, this.next);
      await this.router.navigate(['/dashboard']);
    } catch (err) {
      this.error.set((err as { message?: string }).message ?? 'Password change failed');
    } finally {
      this.loading.set(false);
    }
  }
}
