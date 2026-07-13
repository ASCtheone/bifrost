import { Component, inject, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth.service';
import { environment } from '../../../environments/environment';

/**
 * Public landing page (served at the marketing domain, e.g. asc.ninja/bifrost).
 * The top-left "Connect" button sends visitors to the dashboard sign-in — its
 * target is env-configurable (environment.dashboardUrl) so it points at the
 * dashboard subdomain in production and routes internally in dev.
 */
@Component({
  selector: 'app-landing',
  template: `
    <div class="landing">
      <header class="topbar">
        <button class="connect" (click)="connect()">Connect →</button>
        <div class="brand">
          <img src="logo.png" alt="Bifrost" class="mark" />
          <span class="wordmark">BIFROST</span>
        </div>
      </header>

      <main class="hero">
        <h1>Your network, everywhere.</h1>
        <p class="lede">
          A self-hosted WireGuard mesh VPN with a single control plane. Adopt a
          spark on any site, and every device — laptop, phone, or router — dials
          home over an encrypted tunnel you own end to end.
        </p>
        <div class="cta">
          <button class="connect big" (click)="connect()">Connect →</button>
          <span class="hint">Sign in to the dashboard</span>
        </div>

        <ul class="pillars">
          <li><strong>Self-hosted</strong><span>No cloud lock-in. Your VPS, your keys, your data.</span></li>
          <li><strong>WireGuard</strong><span>Modern, fast, audited crypto on every hop.</span></li>
          <li><strong>Mesh of sparks</strong><span>Bridge each site's UniFi network in minutes.</span></li>
        </ul>
      </main>

      <footer class="foot">Bifrost · self-hosted mesh VPN</footer>
    </div>
  `,
  styles: [`
    :host { display: block; }
    .landing {
      min-height: 100vh; display: flex; flex-direction: column;
      background:
        radial-gradient(1200px 600px at 80% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent),
        var(--bg-secondary);
      color: var(--text-primary);
    }
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.1rem 1.5rem;
    }
    .brand { display: flex; align-items: center; gap: 0.6rem; }
    .mark { width: 34px; height: 34px; }
    .wordmark {
      font-family: 'Audiowide', sans-serif; letter-spacing: 2px;
      font-size: 1.05rem; color: var(--text-secondary);
    }
    .connect {
      background: var(--accent); color: #fff; border: none;
      border-radius: 9px; padding: 0.6rem 1.2rem; min-height: 44px; cursor: pointer;
      font-size: 0.9rem; font-weight: 600; transition: background 0.15s ease, transform 0.1s ease;
    }
    .connect:hover { background: var(--accent-hover); }
    .connect:active { transform: translateY(1px); }
    .connect.big { padding: 0.8rem 1.6rem; font-size: 1rem; }

    .hero {
      flex: 1; max-width: 860px; width: 100%; margin: 0 auto;
      padding: 3rem 1.5rem 2rem; display: flex; flex-direction: column;
      justify-content: center;
    }
    h1 {
      font-family: 'Audiowide', sans-serif; font-size: clamp(2rem, 6vw, 3.4rem);
      line-height: 1.05; margin: 0 0 1rem; letter-spacing: 1px;
    }
    .lede {
      font-size: clamp(1rem, 2.2vw, 1.2rem); color: var(--text-secondary);
      max-width: 620px; margin: 0 0 2rem; line-height: 1.5;
    }
    .cta { display: flex; align-items: center; gap: 0.9rem; margin-bottom: 3rem; }
    .hint { font-size: 0.85rem; color: var(--text-tertiary); }

    .pillars {
      list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    }
    .pillars li {
      background: var(--bg-surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 1rem 1.1rem; display: flex; flex-direction: column; gap: 0.3rem;
    }
    .pillars strong { font-size: 0.95rem; }
    .pillars span { font-size: 0.82rem; color: var(--text-tertiary); line-height: 1.4; }

    .foot { padding: 1.25rem 1.5rem; font-size: 0.78rem; color: var(--text-disabled); }
  `],
})
export class LandingPage implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);

  ngOnInit(): void {
    // An already-authenticated visitor skips the marketing page.
    if (this.authService.isLoggedIn()) {
      void this.router.navigate(['/dashboard']);
    }
  }

  connect(): void {
    const url = environment.dashboardUrl;
    if (url && /^https?:\/\//i.test(url)) {
      window.location.href = url;
    } else {
      void this.router.navigate(['/login']);
    }
  }
}
