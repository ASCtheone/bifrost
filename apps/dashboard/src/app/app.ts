import { Component, inject, signal, OnInit, OnDestroy, HostListener } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router } from '@angular/router';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { AuthService } from './services/auth.service';
import { ThemeService, type ThemeMode } from './services/theme.service';
import { ConfirmService } from './services/confirm.service';
import { gravatarUrl as getGravatarUrl } from './utils/md5';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FaIconComponent],
  template: `
    @if (loggedIn()) {
      <div class="app-shell">
        <!-- Top bar (full width, above everything) -->
        <header class="top-bar">
          <div class="top-left">
            <img src="logo.png" alt="Bifrost" class="top-logo" />
            <span class="top-brand">BIFROST</span>
          </div>
          <div class="top-spacer"></div>
          <div class="top-right">
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
          <main class="content">
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

  loggedIn = signal(false);
  pageTitle = signal('Dashboard');
  menuOpen = signal(false);
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
    }

    // Watch for auth changes
    const checkAuth = () => {
      const u = this.authService.user();
      this.loggedIn.set(!!u);
      if (u) {
        this.setUserInfo(u.email);
      } else {
        this.router.navigate(['/login']);
      }
    };

    // Simple interval-based check (replaces onAuthStateChanged)
    this.authCheckTimer = setInterval(checkAuth, 2000);

    this.router.events.subscribe(() => {
      const url = this.router.url;
      this.pageTitle.set(this.routeTitles[url] ?? 'Dashboard');
    });
  }

  private authCheckTimer: ReturnType<typeof setInterval> | null = null;

  ngOnDestroy(): void {
    if (this.authCheckTimer) clearInterval(this.authCheckTimer);
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
