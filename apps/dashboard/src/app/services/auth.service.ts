import { Injectable, signal, computed } from '@angular/core';
import { signIn, signOut, getCurrentUser, fetchAuthSession, confirmSignIn } from 'aws-amplify/auth';

export interface AuthUser {
  readonly email: string;
  readonly sub: string;
  readonly groups: readonly string[];
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  readonly user = signal<AuthUser | null>(null);
  readonly loading = signal(true);
  private accessToken: string | null = null;

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
      const current = await getCurrentUser();
      const session = await fetchAuthSession();

      // Use ID token for API calls — it contains email, groups, sub
      this.accessToken = session.tokens?.idToken?.toString()
        ?? session.tokens?.accessToken?.toString()
        ?? null;

      const idToken = session.tokens?.idToken;
      const groups = (idToken?.payload?.['cognito:groups'] as string[] | undefined) ?? [];

      this.user.set({
        email: (idToken?.payload?.['email'] as string)
          ?? current.signInDetails?.loginId
          ?? current.username,
        sub: current.userId,
        groups,
      });
    } catch {
      this.user.set(null);
      this.accessToken = null;
    } finally {
      this.loading.set(false);
    }
  }

  async login(identifier: string, password: string): Promise<{ needsNewPassword: boolean }> {
    try { await signOut(); } catch { /* ignore */ }

    const result = await signIn({ username: identifier, password });

    if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      return { needsNewPassword: true };
    }
    if (result.isSignedIn) {
      await this.init();
    }
    return { needsNewPassword: false };
  }

  async completeNewPassword(newPassword: string): Promise<void> {
    const result = await confirmSignIn({ challengeResponse: newPassword });
    if (result.isSignedIn) {
      await this.init();
    }
  }

  async logout(): Promise<void> {
    try { await signOut(); } catch { /* ignore */ }
    this.user.set(null);
    this.accessToken = null;
  }

  async getToken(): Promise<string> {
    try {
      const session = await fetchAuthSession({ forceRefresh: false });
      this.accessToken = session.tokens?.idToken?.toString()
        ?? session.tokens?.accessToken?.toString()
        ?? null;
    } catch {
      this.accessToken = null;
    }
    if (!this.accessToken) {
      throw new Error('No access token available');
    }
    return this.accessToken;
  }

  isLoggedIn(): boolean {
    return this.user() !== null;
  }
}
