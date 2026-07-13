import { Component, inject, signal, OnInit } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  imports: [FormsModule],
  template: `
    <div class="login-container">
      <div class="login-card">
        <div class="login-brand">
          <img src="logo.png" alt="Bifrost" class="login-logo" />
          <h1>BIFROST</h1>
        </div>
        <form (ngSubmit)="login()">
          <div class="field">
            <label>Username or Email</label>
            <input type="text" [(ngModel)]="email" name="email" placeholder="username or email" required />
          </div>
          <div class="field">
            <label>Password</label>
            <input type="password" [(ngModel)]="password" name="password" placeholder="Enter password" required />
          </div>
          @if (error()) {
            <div class="error-msg">{{ error() }}</div>
          }
          <button type="submit" class="btn-login" [disabled]="loading()">
            {{ loading() ? 'Signing in...' : 'Sign In' }}
          </button>
        </form>
      </div>
    </div>
  `,
  styles: [`
    .login-container {
      display: flex; justify-content: center; align-items: center;
      height: 100vh; background: var(--bg-secondary);
    }
    .login-card {
      background: var(--bg-surface); padding: 2.5rem;
      border-radius: 16px; width: 380px;
      border: 1px solid var(--border);
    }
    .login-brand {
      display: flex; flex-direction: column; align-items: center;
      margin-bottom: 2rem;
    }
    .login-logo { width: 56px; height: 56px; margin-bottom: 0.75rem; }
    h1 {
      margin: 0; font-family: 'Audiowide', sans-serif; font-size: 1.2rem;
      color: var(--text-tertiary); letter-spacing: 2px;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.5);
    }

    .field { margin-bottom: 1rem; }
    label {
      display: block; font-size: 0.7rem; font-weight: 500;
      color: var(--text-tertiary); margin-bottom: 0.35rem;
      text-transform: uppercase; letter-spacing: 0.3px;
    }
    input {
      width: 100%; padding: 0.65rem 0.85rem;
      background: var(--bg-input); border: 1px solid var(--border);
      border-radius: 8px; color: var(--text-primary);
      font-size: 0.9rem; box-sizing: border-box;
      transition: border-color 0.15s ease;
    }
    input::placeholder { color: var(--text-disabled); }
    input:focus { outline: none; border-color: var(--accent); }

    .error-msg {
      background: color-mix(in srgb, var(--error) 10%, transparent);
      color: var(--error); font-size: 0.8rem;
      padding: 0.5rem 0.75rem; border-radius: 8px;
      margin-bottom: 1rem;
    }

    .btn-login {
      width: 100%; padding: 0.7rem; background: var(--accent); color: #fff;
      border: none; border-radius: 8px; cursor: pointer;
      font-size: 0.9rem; font-weight: 500;
      transition: background 0.15s ease;
    }
    .btn-login:hover { background: var(--accent-hover); }
    .btn-login:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class LoginPage implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  email = '';
  password = '';
  error = signal('');
  loading = signal(false);

  async ngOnInit(): Promise<void> {
    // First run: no account exists yet — send the operator to the setup screen.
    if (await this.authService.checkSetupNeeded()) {
      await this.router.navigate(['/setup']);
      return;
    }
    // Invite / reset link: ?email=&tmp= pre-fills the form so the user only has
    // to click Sign In, then is guided through setting a new password.
    const qp = this.route.snapshot.queryParamMap;
    const email = qp.get('email');
    const tmp = qp.get('tmp');
    if (email && tmp) {
      this.email = email;
      this.password = tmp;
    }
  }

  async login(): Promise<void> {
    this.error.set('');
    this.loading.set(true);

    try {
      const result = await this.authService.login(this.email, this.password);
      // Accounts with a temporary password must change it first — carry the
      // current (temp) password across so the change screen can pre-fill it.
      if (result.needsNewPassword) {
        await this.router.navigate(['/change-password'], { state: { current: this.password } });
      } else {
        // Return to where the user came from (e.g. device registration), but
        // only internal paths — never an off-site open redirect.
        const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
        if (returnUrl && returnUrl.startsWith('/')) {
          await this.router.navigateByUrl(returnUrl);
        } else {
          await this.router.navigate(['/dashboard']);
        }
      }
    } catch (err) {
      this.error.set((err as { message?: string }).message ?? 'Login failed');
    } finally {
      this.loading.set(false);
    }
  }
}
