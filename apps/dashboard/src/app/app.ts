import { Component, inject, signal, OnInit, OnDestroy, HostListener } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { AuthService } from './services/auth.service';
import { ThemeService, type ThemeMode } from './services/theme.service';
import { ConfirmService } from './services/confirm.service';
import { UpdateService } from './services/update.service';
import { gravatarUrl as getGravatarUrl } from './utils/md5';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FaIconComponent],
  template: `
    @if (loggedIn()) {
      <!-- Full-screen, interaction-blocking update overlay -->
      @if (update.updating()) {
        <div class="update-overlay">
          <div class="update-overlay-inner">
            <img src="logo.png" class="update-overlay-logo" alt="Bifrost" />
            <h2 class="update-overlay-title">Updating the dashboard…</h2>
            <p class="update-overlay-msg">
              The control plane is being updated@if (update.dashboard()?.latest) { to v{{ update.dashboard()!.latest }}}. This page will
              reload automatically when it's back — please don't close this tab.
            </p>
            <div class="update-overlay-bar"><div class="update-overlay-fill" [style.width.%]="update.progress()"></div></div>
            <div class="update-overlay-pct">{{ round(update.progress()) }}%</div>
          </div>
        </div>
      }
      <!-- Prominent error toast (e.g. self-update not configured) -->
      @if (update.error(); as err) {
        <div class="update-toast">
          <fa-icon [icon]="['fal', 'triangle-exclamation']" [fixedWidth]="true"></fa-icon>
          <span>{{ err }}</span>
          <button class="update-toast-close" (click)="update.error.set(null)" title="Dismiss">✕</button>
        </div>
      }
      <div class="app-shell">
        <!-- Top bar (full width, above everything) -->
        <header class="top-bar">
          <div class="top-left">
            <img src="logo.png" alt="Bifrost" class="top-logo" />
            <span class="top-brand">BIFROST</span>
          </div>
          <div class="top-spacer"></div>
          <div class="top-right">
            @if (update.dashboardUpdate(); as d) {
              <button class="top-update-btn" (click)="update.updateDashboard()" [title]="'Update the dashboard to v' + d.latest">
                <fa-icon [icon]="['fal', 'arrow-rotate-right']" [fixedWidth]="true"></fa-icon>
                Update to v{{ d.latest }}
              </button>
            }
            <div class="notif-menu">
              <button class="top-btn" (click)="notifOpen.set(!notifOpen())" title="Updates">
                <fa-icon [icon]="['fal', 'bell']" [fixedWidth]="true"></fa-icon>
                @if (update.count() > 0) { <span class="notif-badge">{{ update.count() }}</span> }
              </button>
              @if (notifOpen()) {
                <div class="dropdown notif-center" (click)="$event.stopPropagation()">
                  <div class="dropdown-header"><div class="dropdown-email">Updates</div></div>
                  <div class="dropdown-divider"></div>
                  @if (update.count() === 0) {
                    <div class="notif-empty">Everything's up to date.</div>
                  }
                  @if (update.dashboardUpdate(); as d) {
                    <div class="notif-item">
                      <fa-icon [icon]="['fal', 'grid-2']" [fixedWidth]="true"></fa-icon>
                      <div style="flex:1">
                        <div class="notif-title">Dashboard update available</div>
                        <div class="notif-sub">v{{ d.current }} → v{{ d.latest }}</div>
                      </div>
                      <button class="notif-update-btn" (click)="update.updateDashboard(); notifOpen.set(false)">Update</button>
                    </div>
                    @if (update.error()) { <div class="notif-err">{{ update.error() }}</div> }
                  }
                  @if (update.sparkUpdates().length) {
                    <button class="dropdown-item" (click)="goToSparks()">
                      <fa-icon [icon]="['fal', 'server']" [fixedWidth]="true"></fa-icon>
                      {{ update.sparkUpdates().length }} spark{{ update.sparkUpdates().length > 1 ? 's' : '' }} can be updated →
                    </button>
                  }
                  <div class="dropdown-divider"></div>
                  <button class="notif-check" (click)="update.checkNow()" [disabled]="update.checking()">
                    <fa-icon [icon]="['fal', 'arrow-rotate-right']" [fixedWidth]="true" [class.spin]="update.checking()"></fa-icon>
                    {{ update.checking() ? 'Checking…' : 'Check for updates' }}
                  </button>
                </div>
              }
            </div>
            <button class="top-btn" (click)="toggleTheme()" [title]="theme.resolved() === 'dark' ? 'Switch to light' : 'Switch to dark'">
              <fa-icon [icon]="['fal', theme.resolved() === 'dark' ? 'moon' : 'sun-bright']" [fixedWidth]="true"></fa-icon>
            </button>
            <div class="avatar-menu">
              <button class="avatar-btn" (click)="menuOpen.set(!menuOpen())">
                <img class="avatar-img" [src]="gravatarUrl()" alt="" referrerpolicy="no-referrer" />
                <span class="avatar-initials">{{ userInitials() }}</span>
              </button>
              @if (menuOpen()) {
                <div class="dropdown" (click)="menuOpen.set(false)">
                  <div class="dropdown-header">
                    <div class="dropdown-email">{{ userEmail() }}</div>
                    <div class="dropdown-role">Administrator</div>
                  </div>
                  <div class="dropdown-divider"></div>
                  <button class="dropdown-item" routerLink="/settings">
                    <fa-icon [icon]="['fal', 'gear']" [fixedWidth]="true"></fa-icon>
                    Settings
                  </button>
                  <button class="dropdown-item danger" (click)="logout()">
                    <fa-icon [icon]="['fal', 'right-from-bracket']" [fixedWidth]="true"></fa-icon>
                    Sign Out
                  </button>
                </div>
              }
            </div>
          </div>
        </header>

        <!-- Update notification bar (the full-screen overlay handles the updating state) -->
        @if (update.count() > 0 && !barDismissed() && !update.updating()) {
          <div class="update-bar">
            <fa-icon [icon]="['fal', 'arrow-rotate-right']" [fixedWidth]="true"></fa-icon>
            <span class="update-bar-text">
              @if (update.dashboardUpdate(); as d) { Dashboard update available (v{{ d.latest }}).&nbsp; }
              @if (update.sparkUpdates().length) { {{ update.sparkUpdates().length }} spark{{ update.sparkUpdates().length > 1 ? 's' : '' }} can be updated. }
            </span>
            @if (update.dashboardUpdate()) {
              <button class="update-bar-btn" (click)="update.updateDashboard()">Update dashboard</button>
            }
            @if (update.sparkUpdates().length) {
              <button class="update-bar-btn ghost" (click)="goToSparks()">Update sparks →</button>
            }
            <button class="update-bar-close" (click)="barDismissed.set(true)" title="Dismiss">✕</button>
          </div>
        }

        <!-- Below top bar: sidebar + content -->
        <div class="below-bar">
          <nav class="icon-rail">
            <div class="rail-top">
              <a routerLink="/dashboard" routerLinkActive="active" [routerLinkActiveOptions]="{exact: true}" class="rail-item" title="Dashboard">
                <fa-icon [icon]="['fal', 'grid-2']" [fixedWidth]="true"></fa-icon>
              </a>
              <a routerLink="/sparks" routerLinkActive="active" class="rail-item" title="Sparks">
                <fa-icon [icon]="['fal', 'server']" [fixedWidth]="true"></fa-icon>
              </a>
              <a routerLink="/devices" routerLinkActive="active" class="rail-item" title="Devices">
                <fa-icon [icon]="['fal', 'laptop-mobile']" [fixedWidth]="true"></fa-icon>
              </a>
              <a routerLink="/topology" routerLinkActive="active" class="rail-item" title="Topology">
                <fa-icon [icon]="['fal', 'sitemap']" [fixedWidth]="true"></fa-icon>
              </a>
              @if (authService.isAdmin()) {
                <div class="rail-divider"></div>
                <a routerLink="/users" routerLinkActive="active" class="rail-item admin-item" title="Users">
                  <fa-icon [icon]="['fal', 'users']" [fixedWidth]="true"></fa-icon>
                </a>
              }
              @if (authService.isSuperadmin()) {
                <a routerLink="/admin/sparks" routerLinkActive="active" class="rail-item admin-item" title="All Sparks">
                  <fa-icon [icon]="['fal', 'shield-halved']" [fixedWidth]="true"></fa-icon>
                </a>
              }
            </div>
          </nav>
          <main class="content" [class.full-bleed]="fullBleed()">
            <router-outlet />
          </main>
        </div>
      </div>
      <!-- Confirm Dialog -->
      @if (confirmService.visible()) {
        <div class="confirm-overlay" (click)="confirmService.cancel()">
          <div class="confirm-dialog" (click)="$event.stopPropagation()">
            <h3 class="confirm-title">{{ confirmService.options().title }}</h3>
            <p class="confirm-message">{{ confirmService.options().message }}</p>
            <div class="confirm-actions">
              <button class="confirm-btn cancel" (click)="confirmService.cancel()">Cancel</button>
              <button class="confirm-btn" [class.danger]="confirmService.options().danger" (click)="confirmService.accept()">
                {{ confirmService.options().confirmLabel || 'Confirm' }}
              </button>
            </div>
          </div>
        </div>
      }
    } @else {
      <router-outlet />
    }
  `,
  styles: [`
    .app-shell { display: flex; flex-direction: column; height: 100vh; }
    .top-bar {
      height: 42px; min-height: 42px;
      display: flex; align-items: center;
      padding: 0 0.75rem 0 0;
      background: var(--topbar-bg);
      border-bottom: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      z-index: 10;
    }
    .top-left {
      display: flex; align-items: center; gap: 0;
      padding: 0 0.75rem;
      border-right: 1px solid var(--border);
      height: 100%;
    }
    .top-logo { width: 20px; height: 20px; }
    .top-brand { font-family: 'Audiowide', sans-serif; font-size: 0.7rem; color: var(--text-disabled); letter-spacing: 2px; margin-left: 0.5rem; }
    .top-spacer { flex: 1; }
    .top-right { display: flex; align-items: center; gap: 4px; }
    .top-btn {
      display: flex; align-items: center; justify-content: center;
      width: 30px; height: 30px;
      border-radius: 6px; border: none; background: none;
      color: var(--text-disabled); cursor: pointer; font-size: 14px;
      transition: all 0.15s ease;
    }
    .top-btn:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .update-toast { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); z-index: 9998; display: flex; align-items: center; gap: 0.6rem; max-width: 560px; padding: 0.6rem 0.9rem; border-radius: 8px; background: var(--bg-surface); border: 1px solid color-mix(in srgb, var(--danger, #ef4444) 45%, var(--border)); box-shadow: 0 8px 24px rgba(0,0,0,0.25); font-size: 0.8rem; color: var(--text-primary); }
    .update-toast > fa-icon { color: var(--danger, #ef4444); flex-shrink: 0; }
    .update-toast-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; padding: 0 4px; font-size: 0.85rem; }
    .update-toast-close:hover { color: var(--text-primary); }
    .top-update-btn { display: flex; align-items: center; gap: 0.35rem; height: 26px; padding: 0 0.7rem; border-radius: 6px; border: none; background: var(--accent); color: #fff; font-size: 0.72rem; font-weight: 600; cursor: pointer; transition: filter 0.15s ease; }
    .top-update-btn:hover { filter: brightness(1.1); }
    .update-overlay { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--bg-base, #14161a) 92%, transparent); backdrop-filter: blur(4px); }
    .update-overlay-inner { width: 100%; max-width: 380px; text-align: center; padding: 2rem; }
    .update-overlay-logo { width: 52px; height: 52px; margin-bottom: 1rem; animation: overlaypulse 1.8s ease-in-out infinite; }
    @keyframes overlaypulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
    .update-overlay-title { margin: 0 0 0.5rem; font-size: 1.15rem; color: var(--text-primary); }
    .update-overlay-msg { margin: 0 0 1.4rem; font-size: 0.82rem; line-height: 1.5; color: var(--text-secondary); }
    .update-overlay-bar { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--accent) 20%, transparent); overflow: hidden; }
    .update-overlay-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .update-overlay-pct { margin-top: 0.6rem; font-size: 0.75rem; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .notif-menu { position: relative; }
    .notif-badge { position: absolute; top: -2px; right: -2px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 8px; background: var(--accent); color: #fff; font-size: 9px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
    .notif-center { right: 0; left: auto; min-width: 260px; }
    .notif-empty { padding: 0.7rem 0.9rem; font-size: 0.78rem; color: var(--text-tertiary); }
    .notif-check { display: flex; align-items: center; gap: 0.5rem; width: 100%; padding: 0.55rem 0.9rem; background: none; border: none; cursor: pointer; font-size: 0.78rem; color: var(--text-secondary); }
    .notif-check:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .notif-check:disabled { cursor: default; opacity: 0.7; }
    .notif-item { display: flex; align-items: center; gap: 0.6rem; padding: 0.6rem 0.9rem; }
    .notif-item fa-icon { color: var(--accent); }
    .notif-title { font-size: 0.8rem; font-weight: 600; color: var(--text-primary); }
    .notif-sub { font-size: 0.7rem; color: var(--text-tertiary); font-family: ui-monospace, monospace; }
    .update-bar { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0.9rem; background: color-mix(in srgb, var(--accent) 14%, var(--topbar-bg)); border-bottom: 1px solid var(--border); font-size: 0.8rem; color: var(--text-primary); }
    .update-bar > fa-icon { color: var(--accent); }
    .update-bar-text { flex: 1; }
    .update-bar-btn { padding: 3px 12px; border-radius: 6px; border: none; background: var(--accent); color: #fff; font-size: 0.72rem; font-weight: 600; cursor: pointer; }
    .update-bar-btn:hover { filter: brightness(1.08); }
    .update-bar-btn.ghost { background: transparent; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); }
    .update-bar-close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; font-size: 0.85rem; padding: 2px 6px; }
    .update-bar-close:hover { color: var(--text-primary); }
    .bar-progress { flex: 0 0 160px; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 20%, transparent); overflow: hidden; }
    .bar-progress-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .notif-update-btn { padding: 3px 10px; border-radius: 6px; border: none; background: var(--accent); color: #fff; font-size: 0.7rem; font-weight: 600; cursor: pointer; }
    .notif-update-btn:hover { filter: brightness(1.08); }
    .notif-progress { height: 5px; margin: 0 0.9rem 0.6rem; border-radius: 3px; background: color-mix(in srgb, var(--accent) 20%, transparent); overflow: hidden; }
    .notif-progress-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .notif-err { padding: 0 0.9rem 0.7rem; font-size: 0.7rem; color: var(--danger, #ef4444); }
    .spin { animation: topspin 1s linear infinite; }
    @keyframes topspin { to { transform: rotate(360deg); } }
    .avatar-menu { position: relative; }
    .avatar-btn {
      display: flex; align-items: center; justify-content: center;
      position: relative; overflow: hidden;
      width: 28px; height: 28px;
      border-radius: 50%; border: none; padding: 0;
      background: var(--accent); color: #fff;
      cursor: pointer; font-size: 0.65rem; font-weight: 600;
      transition: opacity 0.15s ease;
    }
    .avatar-btn:hover { opacity: 0.85; }
    .avatar-img { width: 100%; height: 100%; border-radius: 50%; object-fit: cover; position: absolute; inset: 0; z-index: 1; }
    .avatar-initials { line-height: 1; z-index: 0; }
    .dropdown {
      position: absolute; top: calc(100% + 8px); right: 0;
      width: 220px;
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      z-index: 100; overflow: hidden;
    }
    .dropdown-header { padding: 0.85rem 1rem; }
    .dropdown-email {
      font-size: 0.8rem; font-weight: 500; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dropdown-role { font-size: 0.7rem; color: var(--text-disabled); margin-top: 2px; }
    .dropdown-divider { height: 1px; background: var(--border); }
    .dropdown-item {
      display: flex; align-items: center; gap: 0.5rem;
      width: 100%; padding: 0.6rem 1rem;
      background: none; border: none;
      color: var(--text-secondary); font-size: 0.8rem;
      cursor: pointer; text-align: left;
      transition: background 0.1s ease;
    }
    .dropdown-item:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .dropdown-item.danger:hover { color: var(--error); }
    .below-bar { flex: 1; display: flex; overflow: hidden; }
    .icon-rail {
      width: 48px; min-width: 48px;
      background: var(--sidebar-bg);
      border-right: 1px solid var(--border);
      display: flex; flex-direction: column;
      align-items: center;
      padding: 0.5rem 0;
    }
    .rail-top {
      display: flex; flex-direction: column;
      align-items: center; gap: 2px;
    }
    .rail-item {
      display: flex; align-items: center; justify-content: center;
      width: 34px; height: 34px;
      border-radius: 8px; border: none; background: none;
      color: var(--text-disabled); cursor: pointer;
      text-decoration: none;
      transition: all 0.15s ease;
    }
    .rail-item fa-icon { font-size: 16px; }
    .rail-item:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    a.rail-item.active { background: var(--accent); color: #fff; }
    .rail-divider { width: 24px; height: 1px; background: var(--border); margin: 4px 0; }
    .admin-item { color: var(--warning, #f59e0b) !important; }
    a.admin-item.active { background: linear-gradient(135deg, #f59e0b, #ef4444) !important; color: #fff !important; }
    .content {
      flex: 1; overflow-y: auto;
      padding: 1.75rem 2rem;
      background: var(--bg-primary);
    }
    /* Full-bleed routes (topology) fill the content area exactly — no padding, no scroll. */
    .content.full-bleed { padding: 0; overflow: hidden; }
    .confirm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 2000; }
    .confirm-dialog { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.25rem; width: 340px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); }
    .confirm-title { margin: 0 0 0.4rem; font-size: 0.95rem; font-weight: 600; color: var(--text-primary); }
    .confirm-message { margin: 0 0 1.25rem; font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4; }
    .confirm-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .confirm-btn { padding: 0.45rem 1rem; border-radius: 8px; border: none; font-size: 0.8rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; background: var(--accent); color: #fff; }
    .confirm-btn:hover { opacity: 0.9; }
    .confirm-btn.cancel { background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); }
    .confirm-btn.cancel:hover { background: var(--sidebar-hover); }
    .confirm-btn.danger { background: var(--error); }
  `],
})
export class App implements OnInit, OnDestroy {
  readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  readonly theme = inject(ThemeService);
  readonly confirmService = inject(ConfirmService);
  readonly update = inject(UpdateService);

  loggedIn = signal(false);
  pageTitle = signal('Dashboard');
  fullBleed = signal(false);
  menuOpen = signal(false);
  notifOpen = signal(false);
  barDismissed = signal(false);
  userEmail = signal('');
  userInitials = signal('');
  gravatarUrl = signal('');

  private readonly routeTitles: Record<string, string> = {
    '/dashboard': 'Dashboard',
    '/sparks': 'Sparks',
    '/devices': 'Devices',
    '/users': 'Users',
    '/admin/sparks': 'All Sparks',
  };

  ngOnInit(): void {
    const user = this.authService.user();
    this.loggedIn.set(!!user);
    if (user) {
      this.setUserInfo(user.email);
      this.update.start();
    }
    // Watch for auth changes. Only kick unauthenticated users off *protected*
    // routes — the landing, login and setup pages are public.
    const checkAuth = () => {
      const u = this.authService.user();
      this.loggedIn.set(!!u);
      if (u) {
        this.setUserInfo(u.email);
        this.update.start();
      } else {
        this.update.stop();
        if (!this.isPublicRoute()) this.router.navigate(['/login']);
      }
    };

    // Simple interval-based check (replaces onAuthStateChanged)
    this.authCheckTimer = setInterval(checkAuth, 2000);

    const syncRoute = () => {
      const url = this.router.url;
      this.pageTitle.set(this.routeTitles[url] ?? 'Dashboard');
      // The topology view is full-bleed — it fills the content area with no padding.
      this.fullBleed.set(url.split('?')[0].startsWith('/topology'));
    };
    syncRoute(); // handle a direct load / reload already sitting on /topology
    this.router.events.subscribe(syncRoute);
  }

  private authCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Routes reachable without a session — must not be force-redirected to login. */
  private isPublicRoute(): boolean {
    const url = this.router.url.split('?')[0];
    return url === '/' || url.startsWith('/login') || url.startsWith('/setup')
      || url.startsWith('/device/register');
  }

  ngOnDestroy(): void {
    if (this.authCheckTimer) clearInterval(this.authCheckTimer);
    this.update.stop();
  }

  goToSparks(): void {
    this.notifOpen.set(false);
    this.router.navigate(['/sparks']);
  }

  round(n: number): number {
    return Math.round(n);
  }

  private setUserInfo(email: string): void {
    this.userEmail.set(email);
    this.userInitials.set(
      email.split('@')[0]!.slice(0, 2).toUpperCase()
    );
    this.gravatarUrl.set(getGravatarUrl(email, 56));
  }

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (!target.closest('.avatar-menu')) {
      this.menuOpen.set(false);
    }
  }

  toggleTheme(): void {
    this.theme.setMode(this.theme.resolved() === 'dark' ? 'light' : 'dark');
  }

  async logout(): Promise<void> {
    await this.authService.logout();
    await this.router.navigate(['/login']);
  }
}
