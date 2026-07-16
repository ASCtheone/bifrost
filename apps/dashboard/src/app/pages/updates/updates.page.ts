import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FontAwesomeModule } from '@fortawesome/angular-fontawesome';
import { UpdateService, SparkVersion } from '../../services/update.service';
import { ConfirmService } from '../../services/confirm.service';

// Update Center — a single admin surface to check for, and apply, updates to the
// dashboard/control plane and every spark. All version data + apply logic lives in
// UpdateService (shared with the notification center); this page just renders it.
@Component({
  selector: 'app-updates',
  standalone: true,
  imports: [CommonModule, FontAwesomeModule],
  template: `
    <div class="page">
      <div class="page-head">
        <div>
          <h2>Update Center</h2>
          <p class="sub">Check for and apply updates to the dashboard and your sparks.</p>
        </div>
        <button class="check-btn" (click)="update.checkNow()" [disabled]="update.checking()">
          <fa-icon [icon]="['fal', 'arrow-rotate-right']" [class.spin]="update.checking()"></fa-icon>
          {{ update.checking() ? 'Checking…' : 'Check for updates' }}
        </button>
      </div>

      <!-- Dashboard / control plane -->
      <section class="card">
        <div class="card-row">
          <div class="ico"><fa-icon [icon]="['fal', 'grid-2']"></fa-icon></div>
          <div class="grow">
            <div class="title">Dashboard <span class="muted">· control plane</span></div>
            @if (update.dashboard(); as d) {
              <div class="ver">
                <span class="chip">v{{ d.current }}</span>
                @if (d.updateAvailable) {
                  <fa-icon [icon]="['fal', 'chevron-right']" class="arrow"></fa-icon>
                  <span class="chip new">v{{ d.latest }}</span>
                }
              </div>
            } @else {
              <div class="ver muted">Version unknown</div>
            }
          </div>
          <div class="actions">
            @if (update.updating()) {
              <div class="progress"><div class="bar" [style.width.%]="update.progress()"></div></div>
              <span class="stage">Updating…</span>
            } @else if (update.dashboardUpdate()) {
              <button class="btn primary" (click)="doDashboard()">Update</button>
            } @else {
              <span class="ok"><fa-icon [icon]="['fal', 'circle-check']"></fa-icon> Up to date</span>
            }
          </div>
        </div>
        @if (update.error()) { <div class="err">{{ update.error() }}</div> }
      </section>

      <!-- Sparks -->
      <div class="section-head">
        <h3>Sparks</h3>
        @if (sparkUpdateCount() > 0) { <span class="count-pill">{{ sparkUpdateCount() }} available</span> }
      </div>

      @if (update.sparks().length === 0) {
        <div class="empty">No sparks yet.</div>
      } @else {
        <section class="card">
          @for (s of update.sparks(); track s.id) {
            <div class="card-row spark">
              <div class="ico"><fa-icon [icon]="['fal', 'server']"></fa-icon></div>
              <div class="grow">
                <div class="title">{{ s.name }}</div>
                <div class="ver">
                  @if (s.sparkVersion) {
                    <span class="chip">v{{ s.sparkVersion }}</span>
                  } @else {
                    <span class="muted">version unknown</span>
                  }
                  @if (s.updateAvailable && s.latestVersion) {
                    <fa-icon [icon]="['fal', 'chevron-right']" class="arrow"></fa-icon>
                    <span class="chip new">v{{ s.latestVersion }}</span>
                  }
                </div>
              </div>
              <div class="actions">
                @if (update.sparkStage()[s.id]; as stage) {
                  <fa-icon [icon]="['fal', 'circle-notch']" class="spin"></fa-icon>
                  <span class="stage">{{ stage }}</span>
                } @else {
                  @if (s.updateAvailable) {
                    <button class="btn primary" (click)="doSpark(s)">Update</button>
                  } @else {
                    <span class="ok"><fa-icon [icon]="['fal', 'circle-check']"></fa-icon> Up to date</span>
                  }
                  @if (s.backupAvailable) {
                    <button class="btn ghost" (click)="doRevert(s)" title="Revert to the previous version">Revert</button>
                  }
                }
              </div>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [
    `
    .page { padding: 1.5rem 2rem; max-width: 900px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
    .page-head h2 { margin: 0; font-size: 1.35rem; }
    .sub { margin: 0.25rem 0 0; color: var(--text-tertiary); font-size: 0.85rem; }
    .check-btn { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font-size: 0.85rem; white-space: nowrap; }
    .check-btn:hover:not(:disabled) { background: var(--sidebar-hover); }
    .check-btn:disabled { opacity: 0.65; cursor: default; }

    .card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 1.5rem; }
    .card-row { display: flex; align-items: center; gap: 0.9rem; padding: 0.9rem 1.1rem; }
    .card-row.spark + .card-row.spark { border-top: 1px solid var(--border); }
    .ico { width: 34px; height: 34px; flex: 0 0 34px; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: var(--sidebar-hover); color: var(--text-secondary); }
    .grow { flex: 1; min-width: 0; }
    .title { font-weight: 600; font-size: 0.92rem; }
    .title .muted { font-weight: 400; }
    .muted { color: var(--text-tertiary); }
    .ver { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.25rem; font-size: 0.8rem; }
    .chip { padding: 0.1rem 0.45rem; border-radius: 5px; background: var(--sidebar-hover); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .chip.new { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-weight: 600; }
    .arrow { font-size: 0.65rem; color: var(--text-tertiary); }

    .actions { display: flex; align-items: center; gap: 0.5rem; flex: 0 0 auto; }
    .btn { padding: 0.4rem 0.85rem; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-primary); cursor: pointer; font-size: 0.82rem; }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { filter: brightness(1.06); }
    .btn.ghost:hover { background: var(--sidebar-hover); }
    .ok { display: flex; align-items: center; gap: 0.4rem; color: var(--text-tertiary); font-size: 0.82rem; }
    .ok fa-icon { color: #22c55e; }
    .stage { font-size: 0.8rem; color: var(--text-secondary); }
    .progress { width: 120px; height: 6px; border-radius: 3px; background: color-mix(in srgb, var(--accent) 20%, transparent); overflow: hidden; }
    .progress .bar { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .err { padding: 0 1.1rem 0.9rem; color: #ef4444; font-size: 0.8rem; }

    .section-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; }
    .section-head h3 { margin: 0; font-size: 1rem; }
    .count-pill { padding: 0.1rem 0.5rem; border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-size: 0.72rem; font-weight: 600; }
    .empty { padding: 1.25rem; text-align: center; color: var(--text-tertiary); border: 1px dashed var(--border); border-radius: 12px; }
    .spin { animation: uc-spin 1s linear infinite; }
    @keyframes uc-spin { to { transform: rotate(360deg); } }
    `,
  ],
})
export class UpdatesPage implements OnInit {
  readonly update = inject(UpdateService);
  private readonly confirm = inject(ConfirmService);

  ngOnInit(): void {
    // Ensure fresh data whenever the page opens.
    void this.update.refresh();
  }

  sparkUpdateCount(): number {
    return this.update.sparks().filter((s) => s.updateAvailable).length;
  }

  // Updates apply immediately (no confirmation) — both are health-gated with auto-rollback.
  async doDashboard(): Promise<void> {
    await this.update.updateDashboard();
  }

  async doSpark(s: SparkVersion): Promise<void> {
    await this.update.updateSpark(s);
  }

  async doRevert(s: SparkVersion): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Revert spark',
      message: `Revert "${s.name}" to the previous version (its backup)? The spark restarts into it.`,
      confirmLabel: 'Revert',
      danger: true,
    });
    if (!ok) return;
    await this.update.revertSpark(s);
  }
}
