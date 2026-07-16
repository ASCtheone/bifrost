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
