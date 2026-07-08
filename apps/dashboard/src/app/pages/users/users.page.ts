import { Component, inject, signal, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';

interface UserRow {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly sub: string;
  readonly status: string;
  readonly enabled: boolean;
  readonly groups: readonly string[];
  readonly createdAt: string;
  readonly lastModified: string;
  readonly createdBy: string | null;
}

interface UsersResponse {
  readonly users: readonly UserRow[];
  readonly callerIsSuperadmin: boolean;
}

@Component({
  selector: 'app-users',
  imports: [FormsModule, FaIconComponent],
  template: `
    <div class="page-header">
      <h2>Users</h2>
      <button class="btn-primary" (click)="showAddDialog.set(true)">
        <fa-icon [icon]="['fal', 'plus']" [fixedWidth]="true"></fa-icon>
        Add User
      </button>
    </div>

    <!-- Add User Dialog -->
    @if (showAddDialog()) {
      <div class="overlay" (click)="showAddDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Add User</h3>
          <div class="field">
            <label>Username</label>
            <input type="text" [(ngModel)]="newUser.username" name="username" placeholder="johndoe" />
          </div>
          <div class="field">
            <label>Email</label>
            <input type="email" [(ngModel)]="newUser.email" name="email" placeholder="user@example.com" />
          </div>
          <div class="field">
            <label>Temporary Password</label>
            <input type="text" [(ngModel)]="newUser.password" name="password" placeholder="Leave empty for email invite" />
            <span class="field-hint">User will be asked to change on first login</span>
            @if (newUser.password) {
              <div class="pw-rules">
                <span [class.pass]="newUser.password.length >= 12" [class.fail]="newUser.password.length < 12">12+ chars</span>
                <span [class.pass]="hasUpper()" [class.fail]="!hasUpper()">Uppercase</span>
                <span [class.pass]="hasLower()" [class.fail]="!hasLower()">Lowercase</span>
                <span [class.pass]="hasNumber()" [class.fail]="!hasNumber()">Number</span>
              </div>
            }
          </div>
          @if (isSuperadmin()) {
            <div class="field">
              <label>Owner</label>
              <select [(ngModel)]="newUser.ownerEmail" name="ownerEmail" class="select-field">
                <option [value]="currentEmail()">Me ({{ currentEmail() }})</option>
                @for (admin of adminList(); track admin.email) {
                  @if (admin.email !== currentEmail()) {
                    <option [value]="admin.email">{{ admin.displayName || admin.email }}</option>
                  }
                }
              </select>
              <span class="field-hint">Admin who will manage this user</span>
            </div>
            <div class="field">
              <label class="toggle-label">
                <input type="checkbox" [(ngModel)]="newUser.isAdmin" name="isAdmin" />
                <span>Administrator</span>
              </label>
            </div>
            <div class="field">
              <label class="toggle-label superadmin-toggle">
                <input type="checkbox" [(ngModel)]="newUser.isSuperadmin" name="isSuperadmin" />
                <span>Superadmin</span>
              </label>
              <span class="field-hint">Full control over users and system settings</span>
            </div>
          }
          @if (addError()) {
            <div class="error-msg">{{ addError() }}</div>
          }
          <div class="dialog-actions">
            <button class="btn-secondary" (click)="showAddDialog.set(false)">Cancel</button>
            <button class="btn-primary" (click)="addUser()" [disabled]="addingUser() || !newUser.email || !isPasswordValid()">
              {{ addingUser() ? 'Creating...' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Users Table -->
    <div class="table-card">
      <table>
        <thead>
          <tr>
            <th>User</th>
            @if (isSuperadmin()) { <th>Owner</th> }
            <th>Role</th>
            <th>Status</th>
            <th>Enabled</th>
            <th>Modified</th>
            <th>Created</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (user of users(); track user.username) {
            <tr [class.disabled-row]="!user.enabled">
              <td>
                <div class="user-cell">
                  <div class="avatar-wrap">
                    <img class="avatar-img" [src]="computeGravatar(user.email)" alt="" loading="lazy" referrerpolicy="no-referrer" />
                    <div class="avatar-fallback">{{ getInitials(user.displayName || user.email) }}</div>
                  </div>
                  <div>
                    <div class="cell-primary">{{ user.displayName || user.email.split('@')[0] }}</div>
                    <div class="cell-email-sub">{{ user.email }}</div>
                  </div>
                </div>
              </td>
              @if (isSuperadmin()) {
                <td class="cell-owner">{{ user.createdBy ? user.createdBy.split('@')[0] : '—' }}</td>
              }
              <td>
                <div class="role-badges">
                  @if (isSuperadmin() && !isSelf(user)) {
                    <button class="role-tag" [class.active]="user.groups.includes('superadmin')" (click)="toggleSuperadmin(user)" title="Toggle superadmin">
                      <fa-icon [icon]="['fal', 'bolt']" [fixedWidth]="true"></fa-icon>
                      SA
                    </button>
                  } @else if (user.groups.includes('superadmin')) {
                    <span class="role-pill superadmin">Superadmin</span>
                  }
                  @if (user.groups.includes('admin')) {
                    <span class="role-pill admin">Admin</span>
                  } @else {
                    <span class="role-pill">User</span>
                  }
                </div>
              </td>
              <td>
                <span class="status-pill" [attr.data-status]="user.status">
                  {{ formatStatus(user.status) }}
                </span>
              </td>
              <td>
                <span class="enabled-pill" [class.yes]="user.enabled" [class.no]="!user.enabled" (click)="toggleEnabled(user)" style="cursor:pointer">
                  {{ user.enabled ? 'Yes' : 'No' }}
                </span>
              </td>
              <td class="cell-date">{{ formatDate(user.lastModified) }}</td>
              <td class="cell-date">{{ formatDate(user.createdAt) }}</td>
              <td class="cell-actions">
                @if (isSuperadmin()) {
                  @if (!user.groups.includes('admin')) {
                    <button class="action-btn" (click)="toggleAdmin(user, true)" title="Make admin">
                      <fa-icon [icon]="['fal', 'shield']" [fixedWidth]="true"></fa-icon>
                    </button>
                  } @else {
                    <button class="action-btn" (click)="toggleAdmin(user, false)" title="Remove admin">
                      <fa-icon [icon]="['fal', 'shield']" [fixedWidth]="true" style="opacity:0.4"></fa-icon>
                    </button>
                  }
                }
                <button class="action-btn" (click)="toggleEnabled(user)" [title]="user.enabled ? 'Disable' : 'Enable'">
                  <fa-icon [icon]="['fal', user.enabled ? 'ban' : 'circle-check']" [fixedWidth]="true"></fa-icon>
                </button>
                <button class="action-btn" (click)="resetPassword(user)" title="Reset password">
                  <fa-icon [icon]="['fal', 'key']" [fixedWidth]="true"></fa-icon>
                </button>
                <button class="action-btn danger" (click)="deleteUser(user)" title="Delete user">
                  <fa-icon [icon]="['fal', 'trash-can']" [fixedWidth]="true"></fa-icon>
                </button>
              </td>
            </tr>
          }
          @if (users().length === 0 && !loading()) {
            <tr><td colspan="8" class="empty-state">No users found</td></tr>
          }
        </tbody>
      </table>
    </div>
  `,
  styles: [`
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .page-header h2 { margin: 0; font-size: 1.1rem; color: var(--text-primary); font-weight: 600; }
    .btn-primary { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.8rem; font-weight: 500; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { padding: 0.5rem 1rem; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.8rem; }

    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; }
    .dialog { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; width: 400px; }
    .dialog h3 { margin: 0 0 1rem; color: var(--text-primary); font-size: 1rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.3px; }
    .field input[type="email"], .field input[type="text"] { width: 100%; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; box-sizing: border-box; }
    .field input:focus { outline: none; border-color: var(--accent); }
    .field-hint { display: block; font-size: 0.65rem; color: var(--text-disabled); margin-top: 0.2rem; }
    .toggle-label { display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem; color: var(--text-secondary); text-transform: none; letter-spacing: 0; }
    .toggle-label input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent); }
    .pw-rules { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-top: 0.4rem; }
    .pw-rules span { font-size: 0.6rem; padding: 2px 8px; border-radius: 6px; font-weight: 500; }
    .pw-rules .pass { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .pw-rules .fail { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }

    .table-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    thead { background: var(--bg-secondary); }
    th { padding: 0.65rem 1rem; text-align: left; font-size: 0.7rem; font-weight: 600; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.5px; }
    td { padding: 0.75rem 1rem; border-top: 1px solid var(--border); font-size: 0.85rem; color: var(--text-secondary); }
    tr:hover td { background: color-mix(in srgb, var(--sidebar-hover) 50%, transparent); }
    tr.disabled-row td { opacity: 0.4; }

    .user-cell { display: flex; align-items: center; gap: 0.75rem; }
    .avatar-wrap { position: relative; width: 34px; height: 34px; flex-shrink: 0; }
    .avatar-wrap .avatar-img { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; position: absolute; inset: 0; z-index: 1; }
    .avatar-wrap .avatar-fallback { width: 34px; height: 34px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-weight: 600; position: absolute; inset: 0; z-index: 0; }
    .cell-primary { font-weight: 500; color: var(--text-primary); font-size: 0.85rem; }
    .cell-email-sub { font-size: 0.65rem; color: var(--text-disabled); }
    .cell-owner { font-size: 0.75rem; color: var(--text-tertiary); }
    .cell-date { font-size: 0.75rem; color: var(--text-disabled); white-space: nowrap; }
    .enabled-pill { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 0.6rem; font-weight: 600; }
    .enabled-pill.yes { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .enabled-pill.no { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); }

    .role-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; background: var(--bg-input); color: var(--text-tertiary); }
    .role-pill.admin { background: var(--accent); color: #fff; }
    .role-pill.superadmin { background: linear-gradient(135deg, #f59e0b, #ef4444); color: #fff; }
    .role-badges { display: flex; gap: 0.3rem; align-items: center; }
    .role-tag { display: inline-flex; align-items: center; gap: 0.2rem; padding: 2px 8px; border-radius: 10px; font-size: 0.6rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; cursor: pointer; border: 1px dashed var(--text-disabled); background: none; color: var(--text-disabled); transition: all 0.15s ease; }
    .role-tag:hover { border-color: var(--warning, #f59e0b); color: var(--warning, #f59e0b); background: color-mix(in srgb, var(--warning, #f59e0b) 8%, transparent); }
    .role-tag.active { border: 1px solid transparent; background: linear-gradient(135deg, #f59e0b, #ef4444); color: #fff; cursor: pointer; }
    .role-tag.active:hover { opacity: 0.8; }
    .superadmin-toggle span { color: var(--warning, #f59e0b); }
    .active-icon { color: var(--warning, #f59e0b) !important; }
    .status-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.6rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
    .status-pill[data-status="CONFIRMED"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .status-pill[data-status="FORCE_CHANGE_PASSWORD"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }
    .status-pill[data-status="RESET_REQUIRED"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }

    .cell-actions { display: flex; gap: 4px; justify-content: flex-end; }
    .action-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: none; border: 1px solid var(--border); color: var(--text-tertiary); border-radius: 6px; cursor: pointer; font-size: 0.75rem; transition: all 0.15s ease; }
    .action-btn:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .action-btn.danger:hover { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); border-color: var(--error); }
    .empty-state { text-align: center; color: var(--text-disabled); padding: 2.5rem; }
  `],
})
export class UsersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly confirmSvc = inject(ConfirmService);

  users = signal<UserRow[]>([]);
  loading = signal(true);
  showAddDialog = signal(false);
  addingUser = signal(false);
  addError = signal('');
  isSuperadmin = signal(false);
  adminList = signal<{ email: string; displayName: string }[]>([]);
  newUser = { email: '', username: '', password: '', isAdmin: false, isSuperadmin: false, ownerEmail: '' };

  ngOnInit(): void {
    this.fetchUsers();
  }

  private async fetchUsers(): Promise<void> {
    this.loading.set(true);
    try {
      const res = await this.api.get<UsersResponse>('/users');
      this.users.set([...res.users]);
      this.isSuperadmin.set(res.callerIsSuperadmin ?? false);
      this.adminList.set(
        res.users.filter(u => u.groups.includes('admin') || u.groups.includes('superadmin'))
          .map(u => ({ email: u.email, displayName: u.displayName })),
      );
      // Default owner to current user
      if (!this.newUser.ownerEmail) {
        this.newUser.ownerEmail = this.currentEmail();
      }
    } catch (err) {
      console.error('[users] fetch failed:', err);
    } finally {
      this.loading.set(false);
    }
  }

  private gravatarUrls: Record<string, string> = {};

  computeGravatar(email: string): string {
    if (this.gravatarUrls[email]) return this.gravatarUrls[email];
    const hash = this.md5(email.trim().toLowerCase());
    this.gravatarUrls[email] = `https://www.gravatar.com/avatar/${hash}?s=68&d=retro`;
    return this.gravatarUrls[email];
  }

  private md5(str: string): string {
    // Simple MD5 for Gravatar (browser-compatible)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    // Use a proper hex hash via SubtleCrypto is async, so use a simple approach
    // Gravatar actually needs a real MD5. Let's compute it inline.
    return this.computeMd5(str);
  }

  private computeMd5(s: string): string {
    function md5cycle(x: number[], k: number[]) {
      let a = x[0]!, b = x[1]!, c = x[2]!, d = x[3]!;
      a = ff(a, b, c, d, k[0]!, 7, -680876936); d = ff(d, a, b, c, k[1]!, 12, -389564586);
      c = ff(c, d, a, b, k[2]!, 17, 606105819); b = ff(b, c, d, a, k[3]!, 22, -1044525330);
      a = ff(a, b, c, d, k[4]!, 7, -176418897); d = ff(d, a, b, c, k[5]!, 12, 1200080426);
      c = ff(c, d, a, b, k[6]!, 17, -1473231341); b = ff(b, c, d, a, k[7]!, 22, -45705983);
      a = ff(a, b, c, d, k[8]!, 7, 1770035416); d = ff(d, a, b, c, k[9]!, 12, -1958414417);
      c = ff(c, d, a, b, k[10]!, 17, -42063); b = ff(b, c, d, a, k[11]!, 22, -1990404162);
      a = ff(a, b, c, d, k[12]!, 7, 1804603682); d = ff(d, a, b, c, k[13]!, 12, -40341101);
      c = ff(c, d, a, b, k[14]!, 17, -1502002290); b = ff(b, c, d, a, k[15]!, 22, 1236535329);
      a = gg(a, b, c, d, k[1]!, 5, -165796510); d = gg(d, a, b, c, k[6]!, 9, -1069501632);
      c = gg(c, d, a, b, k[11]!, 14, 643717713); b = gg(b, c, d, a, k[0]!, 20, -373897302);
      a = gg(a, b, c, d, k[5]!, 5, -701558691); d = gg(d, a, b, c, k[10]!, 9, 38016083);
      c = gg(c, d, a, b, k[15]!, 14, -660478335); b = gg(b, c, d, a, k[4]!, 20, -405537848);
      a = gg(a, b, c, d, k[9]!, 5, 568446438); d = gg(d, a, b, c, k[14]!, 9, -1019803690);
      c = gg(c, d, a, b, k[3]!, 14, -187363961); b = gg(b, c, d, a, k[8]!, 20, 1163531501);
      a = gg(a, b, c, d, k[13]!, 5, -1444681467); d = gg(d, a, b, c, k[2]!, 9, -51403784);
      c = gg(c, d, a, b, k[7]!, 14, 1735328473); b = gg(b, c, d, a, k[12]!, 20, -1926607734);
      a = hh(a, b, c, d, k[5]!, 4, -378558); d = hh(d, a, b, c, k[8]!, 11, -2022574463);
      c = hh(c, d, a, b, k[11]!, 16, 1839030562); b = hh(b, c, d, a, k[14]!, 23, -35309556);
      a = hh(a, b, c, d, k[1]!, 4, -1530992060); d = hh(d, a, b, c, k[4]!, 11, 1272893353);
      c = hh(c, d, a, b, k[7]!, 16, -155497632); b = hh(b, c, d, a, k[10]!, 23, -1094730640);
      a = hh(a, b, c, d, k[13]!, 4, 681279174); d = hh(d, a, b, c, k[0]!, 11, -358537222);
      c = hh(c, d, a, b, k[3]!, 16, -722521979); b = hh(b, c, d, a, k[6]!, 23, 76029189);
      a = hh(a, b, c, d, k[9]!, 4, -640364487); d = hh(d, a, b, c, k[12]!, 11, -421815835);
      c = hh(c, d, a, b, k[15]!, 16, 530742520); b = hh(b, c, d, a, k[2]!, 23, -995338651);
      a = ii(a, b, c, d, k[0]!, 6, -198630844); d = ii(d, a, b, c, k[7]!, 10, 1126891415);
      c = ii(c, d, a, b, k[14]!, 15, -1416354905); b = ii(b, c, d, a, k[5]!, 21, -57434055);
      a = ii(a, b, c, d, k[12]!, 6, 1700485571); d = ii(d, a, b, c, k[3]!, 10, -1894986606);
      c = ii(c, d, a, b, k[10]!, 15, -1051523); b = ii(b, c, d, a, k[1]!, 21, -2054922799);
      a = ii(a, b, c, d, k[8]!, 6, 1873313359); d = ii(d, a, b, c, k[15]!, 10, -30611744);
      c = ii(c, d, a, b, k[6]!, 15, -1560198380); b = ii(b, c, d, a, k[13]!, 21, 1309151649);
      a = ii(a, b, c, d, k[4]!, 6, -145523070); d = ii(d, a, b, c, k[11]!, 10, -1120210379);
      c = ii(c, d, a, b, k[2]!, 15, 718787259); b = ii(b, c, d, a, k[9]!, 21, -343485551);
      x[0] = add32(a, x[0]!); x[1] = add32(b, x[1]!); x[2] = add32(c, x[2]!); x[3] = add32(d, x[3]!);
    }
    function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function md51(s: string) {
      const n = s.length; const state = [1732584193, -271733879, -1732584194, 271733878];
      let i: number;
      for (i = 64; i <= n; i += 64) {
        md5cycle(state, md5blk(s.substring(i - 64, i)));
      }
      s = s.substring(i - 64);
      const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
      tail[i >> 2] |= 0x80 << ((i % 4) << 3);
      if (i > 55) { md5cycle(state, tail); for (i = 0; i < 16; i++) tail[i] = 0; }
      tail[14] = n * 8;
      md5cycle(state, tail);
      return state;
    }
    function md5blk(s: string) {
      const md5blks = []; for (let i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      } return md5blks;
    }
    function rhex(n: number) {
      const hc = '0123456789abcdef'; let s = '';
      for (let j = 0; j < 4; j++) s += hc.charAt((n >> (j * 8 + 4)) & 0x0F) + hc.charAt((n >> (j * 8)) & 0x0F);
      return s;
    }
    function add32(a: number, b: number) { return (a + b) & 0xFFFFFFFF; }
    const result = md51(s);
    return rhex(result[0]!) + rhex(result[1]!) + rhex(result[2]!) + rhex(result[3]!);
  }

  currentEmail(): string {
    return this.auth.user()?.email ?? '';
  }

  isSelf(user: UserRow): boolean {
    const me = this.auth.user();
    return !!me && (user.sub === me.sub || user.email === me.email);
  }

  hasUpper(): boolean { return /[A-Z]/.test(this.newUser.password); }
  hasLower(): boolean { return /[a-z]/.test(this.newUser.password); }
  hasNumber(): boolean { return /[0-9]/.test(this.newUser.password); }
  isPasswordValid(): boolean {
    if (!this.newUser.password) return true; // empty = email invite, valid
    return this.newUser.password.length >= 12 && this.hasUpper() && this.hasLower() && this.hasNumber();
  }

  getInitials(email: string): string {
    return email.split('@')[0]?.slice(0, 2).toUpperCase() ?? '??';
  }

  formatStatus(status: string): string {
    switch (status) {
      case 'CONFIRMED': return 'Active';
      case 'FORCE_CHANGE_PASSWORD': return 'Pending';
      case 'RESET_REQUIRED': return 'Reset';
      default: return status;
    }
  }

  formatDate(iso: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString();
  }

  async addUser(): Promise<void> {
    this.addError.set('');
    this.addingUser.set(true);
    try {
      await this.api.post('/users', {
        email: this.newUser.email,
        username: this.newUser.username || undefined,
        temporaryPassword: this.newUser.password || undefined,
        isAdmin: this.newUser.isAdmin || this.newUser.isSuperadmin,
        isSuperadmin: this.newUser.isSuperadmin || undefined,
        ownerEmail: this.newUser.ownerEmail || undefined,
      });
      this.showAddDialog.set(false);
      this.newUser = { email: '', username: '', password: '', isAdmin: false, isSuperadmin: false, ownerEmail: this.currentEmail() };
      await this.fetchUsers();
    } catch (err) {
      this.addError.set(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      this.addingUser.set(false);
    }
  }

  async toggleAdmin(user: UserRow, makeAdmin: boolean): Promise<void> {
    await this.api.put(`/users/${user.username}`, { isAdmin: makeAdmin });
    await this.fetchUsers();
  }

  async toggleSuperadmin(user: UserRow): Promise<void> {
    const isSa = user.groups.includes('superadmin');
    const ok = await this.confirmSvc.confirm({
      title: isSa ? 'Remove Superadmin' : 'Grant Superadmin',
      message: isSa
        ? `Remove superadmin from "${user.displayName || user.email}"?`
        : `Grant superadmin to "${user.displayName || user.email}"? They will have full system control.`,
      confirmLabel: isSa ? 'Remove' : 'Grant',
      danger: isSa,
    });
    if (!ok) return;
    await this.api.put(`/users/${user.username}`, { isSuperadmin: !isSa });
    await this.fetchUsers();
  }

  async toggleEnabled(user: UserRow): Promise<void> {
    await this.api.put(`/users/${user.username}`, { enabled: !user.enabled });
    await this.fetchUsers();
  }

  async resetPassword(user: UserRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Reset Password',
      message: `Send a password reset to "${user.email}"?`,
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    await this.api.put(`/users/${user.username}`, { resetPassword: true });
    await this.fetchUsers();
  }

  async deleteUser(user: UserRow): Promise<void> {
    const ok = await this.confirmSvc.confirm({
      title: 'Delete User',
      message: `Delete user "${user.email}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.api.delete(`/users/${user.username}`);
    await this.fetchUsers();
  }
}
