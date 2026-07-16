import { Injectable, inject, signal, computed } from '@angular/core';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';

export interface VersionInfo {
  readonly current: string;
  readonly latest: string;
  readonly updateAvailable: boolean;
}

export interface SparkVersion {
  readonly id: string;
  readonly name: string;
  readonly status?: string;
  readonly sparkVersion?: string | null;
  readonly latestVersion?: string;
  readonly updateAvailable?: boolean;
  readonly backupAvailable?: boolean;
}

// Tracks available updates for the dashboard (control plane) and every spark, so the
// shell can show a notification bar + center. Polls on a slow cadence — updates are rare.
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private api = inject(ApiService);
  private auth = inject(AuthService);

  readonly dashboard = signal<VersionInfo | null>(null);
  readonly sparks = signal<SparkVersion[]>([]);
  private timer: ReturnType<typeof setInterval> | null = null;

  readonly sparkUpdates = computed(() =>
    this.sparks()
      .filter((s) => s.updateAvailable)
      .map((s) => ({ id: s.id, name: s.name, latest: s.latestVersion })),
  );
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

  readonly checking = signal(false);

  // Force an immediate online re-check (GitHub) for both the dashboard and the sparks,
  // so the user never has to wait for the background poll after publishing a release.
  async checkNow(): Promise<void> {
    if (this.checking()) return;
    this.checking.set(true);
    try {
      this.dashboard.set(await this.api.get<VersionInfo>('/version?refresh=1'));
    } catch {
      /* leave the last-known value */
    }
    await this.refresh();
    this.checking.set(false);
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
        const res = await this.api.get<{ nodes: SparkVersion[] }>('/nodes');
        this.sparks.set(
          res.nodes.map((n) => ({
            id: n.id,
            name: n.name,
            status: n.status,
            sparkVersion: n.sparkVersion,
            latestVersion: n.latestVersion,
            updateAvailable: n.updateAvailable,
            backupAvailable: n.backupAvailable,
          })),
        );
      } catch {
        /* ignore */
      }
    }
  }

  // ---- Per-spark update/revert (in-container binary swap, health-gated, auto-rollback) ----
  // A short per-spark status line shown while an update/revert is applying. Empty = idle.
  readonly sparkStage = signal<Record<string, string>>({});

  private setStage(id: string, stage: string | null): void {
    this.sparkStage.update((m) => {
      const next = { ...m };
      if (stage === null) delete next[id];
      else next[id] = stage;
      return next;
    });
  }

  sparkBusy(id: string): boolean {
    return !!this.sparkStage()[id];
  }

  // Ask a spark to update to the latest release. The apply is asynchronous (the spark picks
  // the command up on its next cycle, downloads, restarts, health-gates), so we poll /nodes
  // and surface the stage until its reported version catches up to the target.
  async updateSpark(s: SparkVersion): Promise<void> {
    if (this.sparkBusy(s.id)) return;
    const target = s.latestVersion ?? '';
    const from = s.sparkVersion ?? '';
    this.setStage(s.id, 'Queued on the spark…');
    try {
      await this.api.post(`/nodes/${s.id}/update`);
    } catch {
      this.setStage(s.id, null);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      await this.refresh();
      const n = this.sparks().find((x) => x.id === s.id);
      if (n && target && n.sparkVersion === target) {
        clearInterval(timer);
        this.setStage(s.id, null);
        return;
      }
      if (n && n.sparkVersion && n.sparkVersion !== from) {
        this.setStage(s.id, `Restarted on v${n.sparkVersion}…`);
      } else {
        this.setStage(s.id, 'Downloading & restarting…');
      }
      // Give up surfacing progress after 6 min — the spark still finishes/rolls back on its own.
      if (Date.now() - startedAt > 6 * 60 * 1000) {
        clearInterval(timer);
        this.setStage(s.id, null);
      }
    }, 4000);
  }

  async revertSpark(s: SparkVersion): Promise<void> {
    if (this.sparkBusy(s.id)) return;
    const from = s.sparkVersion ?? '';
    this.setStage(s.id, 'Reverting…');
    try {
      await this.api.post(`/nodes/${s.id}/revert`);
    } catch {
      this.setStage(s.id, null);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(async () => {
      await this.refresh();
      const n = this.sparks().find((x) => x.id === s.id);
      if (n && n.sparkVersion && n.sparkVersion !== from) {
        clearInterval(timer);
        this.setStage(s.id, null);
        return;
      }
      if (Date.now() - startedAt > 6 * 60 * 1000) {
        clearInterval(timer);
        this.setStage(s.id, null);
      }
    }, 4000);
  }
}
