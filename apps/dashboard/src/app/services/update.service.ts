import { Injectable, inject, signal, computed } from '@angular/core';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';

export interface VersionInfo {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
}

interface NodeLite {
  readonly id: string;
  readonly name: string;
  readonly latestVersion?: string;
  readonly updateAvailable?: boolean;
}

// Tracks available updates for the dashboard (control plane) and every spark, so the
// shell can show a notification bar + center. Polls on a slow cadence — updates are rare.
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly dashboard = signal<VersionInfo | null>(null);
  readonly sparkUpdates = signal<{ id: string; name: string; latest?: string }[]>([]);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly dashboardUpdate = computed(() => (this.dashboard()?.updateAvailable ? this.dashboard() : null));
  readonly count = computed(() => (this.dashboardUpdate() ? 1 : 0) + this.sparkUpdates().length);

  // Dashboard/control-plane self-update state (the updater sidecar pulls + recreates it).
  readonly updating = signal(false);
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);

  // Ask the updater to pull the latest server image and recreate the control plane. The
  // API goes down during the recreate, so we show a timed bar and poll /version until the
  // new version answers, then reload the page onto it.
  async updateDashboard(): Promise<void> {
    if (this.updating()) return;
    const target = this.dashboard()?.latest;
    this.error.set(null);
    this.updating.set(true);
    this.progress.set(5);
    try {
      await this.api.post('/update-self');
    } catch {
      this.updating.set(false);
      this.progress.set(0);
      this.error.set(
        "Couldn't start the update — the updater sidecar isn't deployed, or the control plane needs redeploying. See deploy/docker-compose.yml.",
      );
      return;
    }
    const started = Date.now();
    const est = 90_000; // rough recreate time — the poll below is what actually finishes it
    const poll = setInterval(async () => {
      this.progress.set(Math.min(95, 5 + ((Date.now() - started) / est) * 90));
      try {
        const v = await this.api.get<VersionInfo>('/version');
        if (!v.updateAvailable && (!target || v.current === target)) {
          clearInterval(poll);
          this.progress.set(100);
          setTimeout(() => window.location.reload(), 900);
          return;
        }
      } catch {
        /* control plane is restarting — keep polling */
      }
      // Don't block forever if nothing recreates the container (sidecar missing/broken).
      if (Date.now() - started > 4 * 60 * 1000) {
        clearInterval(poll);
        this.updating.set(false);
        this.progress.set(0);
        this.error.set(
          "The update didn't complete in time — the control plane didn't restart onto the new version. Check the updater sidecar's logs.",
        );
      }
    }, 3000);
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refresh(): Promise<void> {
    try {
      this.dashboard.set(await this.api.get<VersionInfo>('/version'));
    } catch {
      /* leave the last-known value */
    }
    if (this.auth.isAdmin()) {
      try {
        const res = await this.api.get<{ nodes: NodeLite[] }>('/nodes');
        this.sparkUpdates.set(
          res.nodes
            .filter((n) => n.updateAvailable)
            .map((n) => ({ id: n.id, name: n.name, latest: n.latestVersion })),
        );
      } catch {
        /* ignore */
      }
    }
  }
}
