import { Injectable, signal, computed } from '@angular/core';
import { environment } from '../../environments/environment';

export interface AuthUser {
  readonly email: string;
  readonly sub: string;
  readonly groups: readonly string[];
}

interface JwtClaims {
  sub: string;
  email: string;
  groups?: string[];
  exp: number;
}

const TOKEN_KEY = 'bifrost_token';

/**
 * Local-auth service: authenticates against the self-hosted spark-server
 * (`POST /auth/login`) and stores the issued JWT. Replaces AWS Amplify/Cognito.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<AuthUser | null>(null);
  readonly loading = signal(true);
  private token: string | null = null;

  readonly isAdmin = computed(() => {
    const u = this.user();
    return !!u && (u.groups.includes('admin') || u.groups.includes('superadmin'));
  });

  readonly isSuperadmin = computed(() => {
    const u = this.user();
    return !!u && u.groups.includes('superadmin');
  });

  async init(): Promise<void> {
    try {
      const stored = localStorage.getItem(TOKEN_KEY);
      const claims = stored ? decodeJwt(stored) : null;
      if (stored && claims && claims.exp * 1000 > Date.now()) {
        this.token = stored;
        this.user.set({ email: claims.email, sub: claims.sub, groups: claims.groups ?? [] });
      } else {
        this.clearSession();
      }
    } finally {
      this.loading.set(false);
    }
  }

  async login(identifier: string, password: string): Promise<{ needsNewPassword: boolean }> {
    const res = await fetch(`${environment.apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: identifier, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? 'Login failed');
    }
    const data = (await res.json()) as { token: string; mustChangePassword?: boolean };
    this.setSession(data.token);
    // The server issues a usable token even with a change pending; the UI routes
    // the user through the forced change screen before the dashboard.
    return { needsNewPassword: data.mustChangePassword === true };
  }

  /** True when no account exists yet — the app shows the first-run setup screen. */
  async checkSetupNeeded(): Promise<boolean> {
    try {
      const res = await fetch(`${environment.apiUrl}/auth/status`);
      if (!res.ok) return false;
      const data = (await res.json()) as { needsSetup?: boolean };
      return data.needsSetup === true;
    } catch {
      return false;
    }
  }

  /** First-run setup: create the initial super admin and start a session. */
  async setup(email: string, displayName: string, password: string): Promise<void> {
    const res = await fetch(`${environment.apiUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, displayName, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? 'Setup failed');
    }
    const data = (await res.json()) as { token: string };
    this.setSession(data.token);
  }

  /** Change the signed-in user's password (clears any forced-change flag). */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const res = await fetch(`${environment.apiUrl}/auth/change-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${await this.getToken()}`,
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error?: string }).error ?? 'Password change failed');
    }
  }

  async logout(): Promise<void> {
    this.clearSession();
  }

  async getToken(): Promise<string> {
    if (!this.token) {
      throw new Error('No access token available');
    }
    return this.token;
  }

  isLoggedIn(): boolean {
    return this.user() !== null;
  }

  private setSession(token: string): void {
    const claims = decodeJwt(token);
    if (!claims) throw new Error('Invalid token');
    this.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    this.user.set({ email: claims.email, sub: claims.sub, groups: claims.groups ?? [] });
  }

  private clearSession(): void {
    this.token = null;
    localStorage.removeItem(TOKEN_KEY);
    this.user.set(null);
  }
}

/** Decode a JWT payload (no verification — the server verifies; this is display-only). */
function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}
