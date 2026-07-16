import { Component, inject, signal, OnInit, OnDestroy, HostListener } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { FaIconComponent } from '@fortawesome/angular-fontawesome';
import { ApiService } from '../../services/api.service';
import { AuthService } from '../../services/auth.service';
import { WsService } from '../../services/ws.service';
import { ConfirmService } from '../../services/confirm.service';

interface VpnServer {
  readonly id: string;
  readonly name: string;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly publicKey: string;
  // False when disabled on the controller — e.g. because the spark is paused.
  readonly enabled?: boolean;
  // The server's peers, nested (the spark reports the full inventory per cycle).
  readonly peers?: readonly VpnPeer[];
}

interface VpnPeer {
  readonly id: string;
  readonly name: string;
  readonly ip: string;
  readonly publicKey: string;
  readonly enabled: boolean;
  readonly allowedIps?: readonly string[];
}

interface VpnSnapshot {
  readonly servers: readonly VpnServer[];
  readonly peers: readonly VpnPeer[];
}

interface MenuItemT {
  readonly label: string;
  readonly danger?: boolean;
  readonly run: () => void | Promise<void>;
}

interface NodeRow {
  readonly id: string;
  readonly name: string;
  readonly tunnelUrl: string;
  readonly tunnelId: string;
  readonly controllerUrl: string;
  readonly hasControllerApiKey: boolean;
  readonly unifiHost: string;
  readonly unifiPort: number;
  readonly unifiSite: string;
  readonly unifiUsername: string;
  /** The password itself is never sent to the browser — only whether one is set. */
  readonly hasUnifiPassword: boolean;
  readonly hasUnifiApiKey: boolean;
  readonly unifiInsecure: boolean;
  /** What devices will dial. null = spark has no known address yet. */
  readonly endpoint: string | null;
  readonly endpointOverride: string;
  readonly sparkVpnName: string | null;
  readonly sparkVpnId: string | null;
  readonly pendingVpnCreate: boolean;
  // Version: what the spark reports vs. what the control plane ships.
  readonly sparkVersion?: string | null;
  readonly latestVersion?: string;
  readonly updateAvailable?: boolean;
  // Management-command queue + last results (create/update/delete server or peer).
  readonly pendingCommands?: readonly { id: string; kind: string }[];
  readonly commandResults?: readonly {
    id: string;
    ok: boolean;
    error?: string;
    // Present on a peer.create result; privateKey only when the spark generated the key.
    peer?: { serverId: string; ip: string; publicKey: string; privateKey?: string };
  }[];
  readonly role: string;
  readonly priority: number;
  readonly status: string;
  readonly paused: boolean;
  readonly adoptionStatus: string;
  readonly adoptionCode: string | null;
  readonly syncState: string;
  readonly lastAppliedVersion: number;
  readonly wanIp: string | null;
  readonly geo: { city?: string; country?: string; region?: string } | null;
  readonly ispName: string | null;
  readonly speedDown: number | null;
  readonly speedUp: number | null;
  readonly error: string | null;
  readonly actualConfig: VpnSnapshot | null;
  readonly lastSeen: string;
  readonly createdAt: string;
  readonly ownerId: string | null;
  readonly ownerEmail: string | null;
  readonly shared: boolean;
}

interface NodesResponse {
  readonly nodes: readonly NodeRow[];
}

interface NodeEdit {
  name: string;
  controllerUrl: string;
  tunnelUrl: string;
  tunnelId: string;
  priority: number;
}

interface UnifiEdit {
  controllerUrl: string;
  controllerApiKey: string;
  unifiHost: string;
  unifiPort: number;
  unifiSite: string;
  unifiUsername: string;
  /** Blank means "leave the stored secret alone" — see saveUnifi(). */
  unifiPassword: string;
  unifiApiKey: string;
  unifiInsecure: boolean;
  endpointOverride: string;
}

type PanelTab = 'status' | 'config' | 'unifi';

@Component({
  selector: 'app-nodes',
  imports: [DecimalPipe, FormsModule, FaIconComponent],
  template: `
    <div class="page-header">
      <h2>Sparks</h2>
      @if (isAdmin()) {
        <button class="btn-primary" (click)="showAddDialog.set(true)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 5v14m-7-7h14"/></svg>
          Add Spark
        </button>
      }
    </div>

    <!-- Add Spark Dialog -->
    @if (showAddDialog()) {
      <div class="overlay" (click)="showAddDialog.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Add Spark</h3>
          <div class="field">
            <label>Node Name</label>
            <input type="text" [(ngModel)]="newNodeName" name="nodeName" placeholder="e.g. office-spark" />
          </div>
          @if (addError()) {
            <div class="error-msg">{{ addError() }}</div>
          }
          <div class="dialog-actions">
            <button class="btn-secondary" (click)="showAddDialog.set(false)">Cancel</button>
            <button class="btn-primary" (click)="addNode()" [disabled]="addingNode()">
              {{ addingNode() ? 'Creating...' : 'Create' }}
            </button>
          </div>
        </div>
      </div>
    }

    <!-- Install command. Shown right after creating a spark (the adoption code is
         only useful if we actually surface it) and from the Reinstall action. -->
    @if (installCmd()) {
      <div class="overlay" (click)="installCmd.set(null)">
        <div class="dialog dialog-wide" (click)="$event.stopPropagation()">
          <h3>Install this spark</h3>
          <p class="dialog-hint">
            Run this on the machine inside the network you want to bridge. It asks
            whether to install with Docker or as a systemd service, then registers the
            spark here so you can adopt it. The UniFi controller is configured here in
            the dashboard afterwards — not on the box.
          </p>
          <div class="copy-row">
            <input type="text" readonly [value]="installCmd()" (focus)="selectAll($event)" />
            <button class="btn-copy" (click)="copy(installCmd()!)">
              <fa-icon [icon]="['fal', 'copy']" [fixedWidth]="true"></fa-icon>
              {{ copied() ? 'Copied' : 'Copy' }}
            </button>
          </div>
          <p class="dialog-hint dim">
            The adoption code expires in 24 hours. Re-running the command later just
            updates the spark — it won't ask anything again.
          </p>
          <div class="dialog-actions">
            <button class="btn-primary" (click)="installCmd.set(null)">Done</button>
          </div>
        </div>
      </div>
    }

    <!-- Assign Dialog -->
    @if (assignNodeId()) {
      <div class="overlay" (click)="assignNodeId.set(null)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Assign Spark</h3>
          <div class="field">
            <label>Select User</label>
            <select [(ngModel)]="assignEmail" name="assignUser" class="select-field">
              <option value="">Choose a user...</option>
              @for (user of userList(); track user.email) {
                <option [value]="user.email">{{ user.displayName || user.email }}</option>
              }
            </select>
          </div>
          <div class="dialog-actions">
            <button class="btn-secondary" (click)="assignNodeId.set(null)">Cancel</button>
            <button class="btn-primary" (click)="assignSpark()" [disabled]="!assignEmail">Assign</button>
          </div>
        </div>
      </div>
    }

    <!-- Share Dialog -->
    @if (shareNodeId()) {
      <div class="overlay" (click)="shareNodeId.set(null)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <h3>Share Spark</h3>
          <div class="share-list">
            @for (share of shareList(); track share.email) {
              <div class="share-row">
                <span>{{ share.email }}</span>
                <button class="unassign-btn" (click)="removeSpark(share.email)" title="Remove">
                  <fa-icon [icon]="['fal', 'xmark']" [fixedWidth]="true"></fa-icon>
                </button>
              </div>
            }
            @if (shareList().length === 0) {
              <div class="empty-hint">Not shared with anyone</div>
            }
          </div>
          <div class="share-add">
            <select [(ngModel)]="shareEmail" name="shareEmail" class="share-input">
              <option value="">Select a user...</option>
              @for (user of shareableUsers(); track user.email) {
                <option [value]="user.email">{{ user.displayName || user.email }}{{ user.groups.includes('admin') ? ' (Admin)' : user.groups.includes('superadmin') ? ' (Superadmin)' : '' }}</option>
              }
            </select>
            <button class="btn-primary btn-sm-inline" (click)="addShare()" [disabled]="!shareEmail">Share</button>
          </div>
          <div class="dialog-actions">
            <button class="btn-primary" (click)="shareNodeId.set(null)">Done</button>
          </div>
        </div>
      </div>
    }

    <div class="nodes-list">
      @for (node of nodes(); track node.id) {
        <div class="node-card" [class.expanded]="expandedNodeId() === node.id" [class.row-busy]="busyNodeId() === node.id">

          <!-- Header row (always visible) -->
          <div class="node-header" [class.shared]="node.shared" (click)="node.shared ? null : toggleExpand(node.id)">
            <div class="node-info">
              <span class="expand-icon">{{ node.shared ? '' : (expandedNodeId() === node.id ? '▾' : '▸') }}</span>
              <div>
                @if (renamingNodeId() === node.id) {
                  <input class="inline-rename" [(ngModel)]="renameValue" (click)="$event.stopPropagation()" (keydown.enter)="saveRename(node.id)" (keydown.escape)="renamingNodeId.set(null)" autofocus />
                } @else {
                  <div class="cell-primary" (dblclick)="startRename(node); $event.stopPropagation()">{{ node.name }}</div>
                }
                <div class="cell-secondary">
                  {{ node.id }}
                  @if (node.geo?.city) {
                    <span class="geo-label">{{ node.geo!.city }}, {{ node.geo!.country }}</span>
                  }
                  @if (node.wanIp) {
                    <span class="wan-ip">{{ node.wanIp }}</span>
                  }
                  @if (node.ispName) {
                    <span class="isp-label">{{ node.ispName }}</span>
                  }
                  @if (node.speedDown) {
                    <span class="speed-label">↓&nbsp;{{ node.speedDown | number:'1.0-0' }}<span class="speed-sep">·</span>↑&nbsp;{{ node.speedUp | number:'1.0-0' }}<span class="speed-unit">Mbps</span></span>
                  }
                  @if (node.sparkVersion) {
                    <span class="version-label">v{{ node.sparkVersion }}</span>
                  }
                </div>
              </div>
            </div>
            <div class="node-badges">
              @if (node.updateAvailable) {
                <span class="update-pill" [title]="'v' + node.latestVersion + ' available (running v' + node.sparkVersion + ')'">Update available</span>
              }
              <span class="role-pill" [class.primary]="node.role === 'primary'">{{ node.role }}</span>
              <div class="status-cell">
                <span class="status-dot"
                  [class.online]="node.status === 'online' && !node.paused"
                  [class.offline]="node.status === 'offline' && !node.paused"
                  [class.paused]="node.paused"
                  [class.pending]="node.adoptionStatus === 'pending'">
                </span>
                {{ node.adoptionStatus === 'adopted' ? (node.paused ? 'paused' : node.status) : node.adoptionStatus }}
              </div>
              @if (node.adoptionStatus === 'available') {
                <button class="adopt-btn" (click)="adoptNode(node.id); $event.stopPropagation()" [disabled]="busyNodeId() === node.id">
                  @if (busyNodeId() === node.id) {
                    <span class="spinner"></span> Working...
                  } @else {
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                    Adopt
                  }
                </button>
              } @else {
                <span class="adoption-pill" [attr.data-status]="node.adoptionStatus">{{ node.adoptionStatus }}</span>
              }
              @if (node.shared) {
                <span class="shared-pill">Shared</span>
              }
            </div>
            @if (isAdmin()) {
              <div class="owner-badge" (click)="$event.stopPropagation()">
                @if (node.ownerEmail) {
                  <span class="owner-label" title="Owner: {{ node.ownerEmail }}">{{ node.ownerEmail.split('@')[0] }}</span>
                  <button class="unassign-btn" (click)="unassignSpark(node.id, node.name)" title="Unassign owner">
                    <fa-icon [icon]="['fal', 'xmark']" [fixedWidth]="true"></fa-icon>
                  </button>
                } @else {
                  <button class="assign-btn" (click)="showAssignDialog(node.id)" title="Assign to user">
                    <fa-icon [icon]="['fal', 'user-plus']" [fixedWidth]="true"></fa-icon>
                    Assign
                  </button>
                }
              </div>
            }
            <div class="node-actions" (click)="$event.stopPropagation()">
              @if (!node.shared) {
                <!-- Copy the install one-liner for this spark, any time. Non-destructive:
                     it carries the adoption code while the spark is still pending, and
                     is the plain update command once adopted (an update needs no code).
                     Minting a fresh code is the separate, explicit Reinstall action —
                     copying must never revoke a running spark's key. -->
                <button
                  class="action-btn"
                  (click)="copyInstall(node)"
                  [title]="node.adoptionCode ? 'Copy install command (with adoption code)' : 'Copy update command'"
                >
                  @if (copiedNodeId() === node.id) {
                    <fa-icon [icon]="['fal', 'circle-check']" [fixedWidth]="true"></fa-icon>
                  } @else {
                    <fa-icon [icon]="['fal', 'copy']" [fixedWidth]="true"></fa-icon>
                  }
                </button>
              }
              @if (!node.shared && isAdmin()) {
                <button class="action-btn" (click)="openShareDialog(node.id)" title="Share spark">
                  <fa-icon [icon]="['fal', 'share-nodes']" [fixedWidth]="true"></fa-icon>
                </button>
              }
              @if (node.adoptionStatus !== 'revoked' && !node.shared) {
                <button class="action-btn" (click)="downloadConfig(node.id)" title="Download config">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4m4-5l5 5 5-5m-5 5V3"/></svg>
                </button>
              }
              @if (node.adoptionStatus === 'adopted' && !node.shared) {
                <button class="action-btn" [class.resume]="node.paused" (click)="node.paused ? resumeNode(node.id) : pauseNode(node.id)" [disabled]="busyNodeId() === node.id" [title]="node.paused ? 'Resume spark' : 'Pause spark'">
                  @if (node.paused) {
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M8 5v14l11-7z"/></svg>
                  } @else {
                    <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>
                  }
                </button>
              }
              @if (node.adoptionStatus === 'adopted' && isAdmin() && !node.shared) {
                <!-- Issues a NEW adoption code and drops the current key, so the spark
                     can be built from scratch. Confirm-gated; the copy button above is
                     the non-destructive path for a plain update. -->
                <button class="action-btn warning" (click)="reinstall(node)" [disabled]="busyNodeId() === node.id" title="Reinstall — issue a new adoption code">
                  <fa-icon [icon]="['fal', 'arrow-rotate-right']" [fixedWidth]="true"></fa-icon>
                </button>
              }
              @if (node.adoptionStatus === 'adopted') {
                <button class="action-btn warning" (click)="revokeNode(node.id, node.name)" title="Revoke key">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15"><path d="M18.36 6.64A9 9 0 015.64 18.36M5.64 5.64A9 9 0 0118.36 18.36M1 1l22 22"/></svg>
                </button>
              }
              <button class="action-btn danger" (click)="remove(node.id, node.name)" title="Delete spark">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="15" height="15"><path d="M3 6h18m-2 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
              </button>
            </div>
          </div>

          <!-- Expandable config panel -->
          @if (expandedNodeId() === node.id) {
            <div class="node-panel">
              <!-- Tabs -->
              <div class="panel-tabs">
                <button class="tab" [class.active]="activeTab() === 'status'" (click)="activeTab.set('status')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                  Status
                </button>
                <button class="tab" [class.active]="activeTab() === 'config'" (click)="activeTab.set('config')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
                  Spark Config
                </button>
                <button class="tab" [class.active]="activeTab() === 'unifi'" (click)="activeTab.set('unifi')">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><circle cx="12" cy="20" r="1"/></svg>
                  UniFi
                </button>
              </div>

              <!-- Status tab -->
              @if (activeTab() === 'status') {
                <div class="tab-content">
                  <div class="panel-grid-2">
                    <div class="panel-section">
                      <div class="info-row">
                        <span class="info-label">Sync State</span>
                        <span class="sync-pill" [attr.data-state]="node.syncState">{{ node.syncState }}</span>
                      </div>
                      <div class="info-row">
                        <span class="info-label">Config Version</span>
                        <span class="info-value">{{ node.lastAppliedVersion }}</span>
                      </div>
                      <div class="info-row">
                        <span class="info-label">Last Seen</span>
                        <span class="info-value">{{ formatTime(node.lastSeen) }}</span>
                      </div>
                      <div class="info-row">
                        <span class="info-label">Created</span>
                        <span class="info-value">{{ formatDate(node.createdAt) }}</span>
                      </div>
                      @if (node.error) {
                        <div class="info-row error">
                          <span class="info-label">Error</span>
                          <span class="info-value error-text">{{ node.error }}</span>
                        </div>
                      }
                    </div>
                    <div class="panel-section">
                      @if (node.adoptionStatus === 'adopted') {
                        <div class="panel-actions">
                          @if (node.role !== 'primary') {
                            <button class="btn-sm accent" (click)="promote(node.id)">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M5 12l5-5 5 5m-5-5v12"/></svg>
                              Promote to Primary
                            </button>
                          }
                          <button class="btn-sm secondary" (click)="forceResync(node.id)">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                            Force Resync
                          </button>
                        </div>
                      }
                    </div>
                  </div>
                </div>
              }

              <!-- Config tab -->
              @if (activeTab() === 'config') {
                <div class="tab-content">
                  @if (editingNodeId() === node.id) {
                    <div class="edit-form compact">
                      <div class="edit-grid">
                        <div class="field-sm">
                          <label>Name</label>
                          <input type="text" [(ngModel)]="editForm.name" name="editName" />
                        </div>
                        <div class="field-sm">
                          <label>Priority</label>
                          <input type="number" [(ngModel)]="editForm.priority" name="editPriority" min="1" max="999" />
                        </div>
                        <div class="field-sm full">
                          <label>Tunnel URL</label>
                          <input type="text" [(ngModel)]="editForm.tunnelUrl" name="editTunnel" placeholder="https://tunnel.example.com" />
                        </div>
                      </div>
                      <div class="edit-actions">
                        <button class="btn-sm secondary" (click)="cancelEdit()">Cancel</button>
                        <button class="btn-sm primary" (click)="saveNode(node.id)" [disabled]="busyNodeId() === node.id">
                          {{ busyNodeId() === node.id ? 'Saving...' : 'Save' }}
                        </button>
                      </div>
                    </div>
                  } @else {
                    <div class="panel-grid-2">
                      <div class="panel-section">
                        <div class="info-row">
                          <span class="info-label">Tunnel URL</span>
                          <span class="info-value mono">{{ node.tunnelUrl || '—' }}</span>
                        </div>
                        <div class="info-row">
                          <span class="info-label">Priority</span>
                          <span class="info-value">{{ node.priority }}</span>
                        </div>
                      </div>
                    </div>
                    @if (node.adoptionStatus === 'adopted') {
                      <button class="btn-sm secondary edit-btn" (click)="startEdit(node)">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                        Edit
                      </button>
                    }
                  }
                </div>
              }

              <!-- UniFi tab -->
              @if (activeTab() === 'unifi') {
                <div class="tab-content">
                  <!-- Connection settings -->
                  <div class="unifi-section">
                    <div class="section-header">
                      <h4>Connection</h4>
                      @if (node.adoptionStatus === 'adopted' && editingUnifiId() !== node.id) {
                        <button class="btn-sm secondary" (click)="startUnifiEdit(node)">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                          Edit
                        </button>
                      }
                    </div>
                    @if (editingUnifiId() === node.id) {
                      <div class="edit-form compact">
                        <div class="edit-grid">
                          <div class="field-sm">
                            <label>Controller host</label>
                            <input type="text" [(ngModel)]="unifiForm.unifiHost" name="unifiHost" placeholder="192.168.1.1" />
                          </div>
                          <div class="field-sm">
                            <label>Port</label>
                            <input type="number" [(ngModel)]="unifiForm.unifiPort" name="unifiPort" placeholder="443" />
                          </div>
                          <div class="field-sm">
                            <label>Site</label>
                            <input type="text" [(ngModel)]="unifiForm.unifiSite" name="unifiSite" placeholder="default" />
                          </div>
                          <div class="field-sm full">
                            <label>API key</label>
                            <input
                              type="password"
                              [(ngModel)]="unifiForm.unifiApiKey"
                              name="unifiApiKey"
                              autocomplete="new-password"
                              [placeholder]="node.hasUnifiApiKey ? 'Unchanged — type to replace' : 'Paste the API key'"
                            />
                            <span class="field-hint">
                              UniFi Console → Settings → Control Plane → Integrations → API Keys.
                              Stored encrypted and sent only to this spark; leave blank to keep the current one.
                            </span>
                          </div>
                          <div class="field-sm full">
                            <label class="inline">
                              <input type="checkbox" [(ngModel)]="unifiForm.unifiInsecure" name="unifiInsecure" />
                              Accept the controller's self-signed certificate (usual for UniFi)
                            </label>
                          </div>
                          <div class="field-sm full">
                            <label>WireGuard endpoint (optional)</label>
                            <input
                              type="text"
                              [(ngModel)]="unifiForm.endpointOverride"
                              name="endpointOverride"
                              [placeholder]="node.wanIp ? 'Auto — ' + node.wanIp : 'Auto — detected on first heartbeat'"
                            />
                            <span class="field-hint">
                              What devices dial for the tunnel — not the controller. Leave blank
                              to use the spark's public IP, which the control plane detects
                              itself and keeps up to date. Set it only for a DDNS name or a
                              static address.
                            </span>
                          </div>
                        </div>
                        <div class="edit-actions">
                          <button class="btn-sm secondary" (click)="cancelUnifiEdit()">Cancel</button>
                          <button class="btn-sm primary" (click)="saveUnifi(node.id)" [disabled]="busyNodeId() === node.id">
                            {{ busyNodeId() === node.id ? 'Saving...' : 'Save' }}
                          </button>
                        </div>
                      </div>
                    } @else {
                      @if (!node.unifiHost || !node.hasUnifiApiKey) {
                        <div class="empty-state">
                          No UniFi controller configured — this spark is idle until you set a
                          host and an API key.
                        </div>
                      }
                      <div class="info-row">
                        <span class="info-label">Controller</span>
                        <span class="info-value mono">
                          {{ node.unifiHost ? node.unifiHost + ':' + node.unifiPort + ' (' + node.unifiSite + ')' : '—' }}
                        </span>
                      </div>
                      <div class="info-row">
                        <span class="info-label">API key</span>
                        <span class="info-value">{{ node.hasUnifiApiKey ? '•••••••••••• (encrypted)' : 'Not configured' }}</span>
                      </div>
                      @if (unifiConfigured(node)) {
                        <div class="info-row">
                          <span class="info-label">Connection</span>
                          <span class="info-value">
                            <button class="btn-sm secondary" (click)="testUnifi(node)" [disabled]="busyNodeId() === node.id">
                              {{ busyNodeId() === node.id ? 'Testing…' : 'Test connection' }}
                            </button>
                          </span>
                        </div>
                        @if (unifiTest(); as tr) {
                          @if (tr.nodeId === node.id) {
                            <div class="unifi-test" [class.ok]="tr.ok" [class.fail]="!tr.ok">
                              <fa-icon [icon]="['fal', tr.ok ? 'circle-check' : 'triangle-exclamation']" [fixedWidth]="true"></fa-icon>
                              {{ tr.message }}
                            </div>
                          }
                        }
                      }
                      <div class="info-row">
                        <span class="info-label">WireGuard endpoint</span>
                        <span class="info-value mono">
                          @if (node.endpointOverride) {
                            {{ node.endpointOverride }} <span class="dim-note">(manual)</span>
                          } @else if (node.endpoint) {
                            {{ node.endpoint }} <span class="dim-note">(auto-detected)</span>
                          } @else {
                            <span class="warn">unknown — no heartbeat yet, so no device configs can be built</span>
                          }
                        </span>
                      </div>
                    }
                  </div>

                  <!-- VPN Servers -->
                  <div class="unifi-section">
                    <div class="section-header">
                      <h4>VPN Servers</h4>
                      <button class="btn-sm secondary" (click)="addServer(node)" [disabled]="busyNodeId() === node.id || node.status !== 'online' || !unifiConfigured(node)" [title]="!unifiConfigured(node) ? 'Configure the UniFi controller first' : 'Create a new WireGuard server (auto 10.13.x subnet)'">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 5v14m-7-7h14"/></svg>
                        Add VPN
                      </button>
                      <button class="btn-sm secondary" (click)="refreshNode(node.id)" [disabled]="busyNodeId() === node.id" title="Refresh from controller">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12" [class.spinning]="busyNodeId() === node.id"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                        {{ busyNodeId() === node.id ? 'Refreshing...' : 'Refresh' }}
                      </button>
                      @if (hasPendingCommands(node)) {
                        <span class="cmd-pending"><span class="spinner-sm"></span> applying…</span>
                      }
                      @if (node.status === 'online') {
                        <span class="freshness" title="How long since the spark last reported the controller state">scanned {{ lastSeenAgo(node) }}</span>
                      }
                      @if (node.actualConfig?.servers?.length) {
                        <span class="count-badge">{{ node.actualConfig!.servers.length }}</span>
                      }
                    </div>

                    <div class="vpn-cards">
                      <!-- Create button tile (first, if no spark VPN yet) -->
                      @if (!isSparkVpn(node) && node.adoptionStatus === 'adopted') {
                        <button class="vpn-card create-tile"
                                [class.disabled]="node.status !== 'online' || !unifiConfigured(node)"
                                (click)="createVpn(node.id)"
                                [disabled]="busyNodeId() === node.id || node.status !== 'online' || !unifiConfigured(node)"
                                [title]="!unifiConfigured(node) ? 'Configure the UniFi controller first (UniFi tab)' : (node.status !== 'online' ? 'The spark must be online before you can create a VPN' : 'Create the Bifrost VPN on this spark')">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="24" height="24"><path d="M12 5v14m-7-7h14"/></svg>
                          @if (!unifiConfigured(node)) {
                            <span>UniFi not configured</span>
                            <span class="create-hint">Set the controller in the UniFi tab first</span>
                          } @else if (node.status !== 'online') {
                            <span>Spark offline</span>
                            <span class="create-hint">Bring the spark online first</span>
                          } @else {
                            <span>Create Spark VPN</span>
                          }
                        </button>
                      }

                      <!-- Spark VPN card (first, highlighted) -->
                      @if (isSparkVpn(node)) {
                        <div class="vpn-card spark-vpn" (contextmenu)="openSparkMenu($event, node)">
                          <div class="vpn-card-header">
                            <div class="spark-vpn-badge">
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>
                              <span class="vpn-name">{{ node.sparkVpnName }}</span>
                              @if (getSparkServer(node)?.enabled === false) {
                                <span class="disabled-pill">Paused</span>
                              }
                            </div>
                            <div class="vpn-card-actions">
                              <button class="btn-sm secondary"
                                      (click)="recreateVpn(node)"
                                      [disabled]="busyNodeId() === node.id || node.status !== 'online'"
                                      [title]="node.status !== 'online' ? 'The spark must be online to recreate the VPN' : 'Provision a fresh WireGuard server on the controller'">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12" [class.spinning]="busyNodeId() === node.id"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/></svg>
                                Recreate
                              </button>
                              <span class="spark-pill">BIFROST</span>
                            </div>
                          </div>
                          @if (getSparkServer(node); as sparkServer) {
                            <div class="vpn-details">
                              <div class="vpn-detail">
                                <span class="info-label">Address</span>
                                <code class="mono-sm">{{ sparkServer.serverAddress }}</code>
                              </div>
                              <div class="vpn-detail">
                                <span class="info-label">Public Key</span>
                                <code class="mono-sm truncate">{{ sparkServer.publicKey || '—' }}</code>
                              </div>
                            </div>
                          }
                          @if (node.pendingVpnCreate) {
                            <div class="vpn-pending" [class.waiting]="node.status !== 'online'">
                              @if (node.status === 'online') {
                                <span class="spinner"></span> Creating on controller...
                              } @else {
                                <span class="wait-dot"></span> Waiting for spark to connect...
                              }
                            </div>
                          } @else if (!getSparkServer(node)) {
                            <div class="vpn-missing">Server not found on the controller — click Recreate to provision a fresh one.</div>
                          }
                        </div>
                      }

                      <!-- Other VPN servers on this controller (not spark-owned) -->
                      @if (node.actualConfig?.servers?.length) {
                        @for (server of node.actualConfig!.servers; track server.id) {
                          @if (!isSparkServer(node, server)) {
                            <div class="vpn-card dimmed" (contextmenu)="openServerMenu($event, node, server)">
                              <div class="vpn-card-header">
                                <span class="vpn-name">{{ server.name }}</span>
                                @if (server.enabled === false) {
                                  <span class="disabled-pill">Disabled</span>
                                }
                                <div class="vpn-card-actions">
                                  @if (server.peers?.length) {
                                    <span class="count-badge">{{ server.peers!.length }}</span>
                                  }
                                  <button class="icon-btn" (click)="renameServer(node, server)" [disabled]="busyNodeId() === node.id" title="Rename server">
                                    <fa-icon [icon]="['fal', 'pen']" [fixedWidth]="true"></fa-icon>
                                  </button>
                                  <button class="icon-btn danger" (click)="deleteServer(node, server)" [disabled]="busyNodeId() === node.id" title="Delete server">
                                    <fa-icon [icon]="['fal', 'trash-can']" [fixedWidth]="true"></fa-icon>
                                  </button>
                                </div>
                              </div>
                              <div class="vpn-details">
                                <div class="vpn-detail">
                                  <span class="info-label">Address</span>
                                  <code class="mono-sm">{{ server.serverAddress }}</code>
                                </div>
                                <div class="vpn-detail">
                                  <span class="info-label">Port</span>
                                  <code class="mono-sm">{{ server.serverPort }}</code>
                                </div>
                              </div>
                              <div class="peer-list compact">
                                @for (peer of server.peers ?? []; track peer.id) {
                                  <div class="peer-row" (contextmenu)="openPeerMenu($event, node, server, peer)">
                                    <div class="peer-info">
                                      <span class="peer-name">{{ peer.name }}</span>
                                      <code class="mono-sm">{{ peer.ip }}</code>
                                    </div>
                                    <div class="peer-actions">
                                      <button class="icon-btn" (click)="renamePeer(node, server, peer)" [disabled]="busyNodeId() === node.id" title="Rename client">
                                        <fa-icon [icon]="['fal', 'pen']" [fixedWidth]="true"></fa-icon>
                                      </button>
                                      <button class="icon-btn danger" (click)="deletePeer(node, server, peer)" [disabled]="busyNodeId() === node.id" title="Delete client">
                                        <fa-icon [icon]="['fal', 'trash-can']" [fixedWidth]="true"></fa-icon>
                                      </button>
                                    </div>
                                  </div>
                                }
                                @if (!server.peers?.length) {
                                  <div class="peer-empty">No clients</div>
                                }
                              </div>
                              <button class="btn-sm secondary add-client" (click)="addPeer(node, server)" [disabled]="busyNodeId() === node.id || node.status !== 'online'" title="Add a WireGuard client to this server">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M12 5v14m-7-7h14"/></svg>
                                Add client
                              </button>
                            </div>
                          }
                        }
                      }
                    </div>
                    @if (generatedConfig(node); as cfg) {
                      <div class="config-panel">
                        <div class="config-head">
                          <span>Client config ready — {{ cfg.label }}</span>
                          <button class="icon-btn" (click)="dismissConfig(cfg.id)" title="Dismiss">
                            <fa-icon [icon]="['fal', 'xmark']" [fixedWidth]="true"></fa-icon>
                          </button>
                        </div>
                        <pre class="config-body">{{ cfg.config }}</pre>
                        <div class="config-actions">
                          <button class="btn-sm secondary" (click)="copyConfig(cfg.config)">Copy</button>
                          <button class="btn-sm secondary" (click)="downloadClientConfig(cfg)">Download .conf</button>
                        </div>
                      </div>
                    }
                    @for (fail of failedCommands(node); track fail.id) {
                      <div class="cmd-error">
                        <fa-icon [icon]="['fal', 'triangle-exclamation']" [fixedWidth]="true"></fa-icon>
                        Last operation failed: {{ fail.error || 'unknown error' }}
                      </div>
                    }
                  </div>

                  <!-- Bifrost Peers -->
                  <div class="unifi-section">
                    <div class="section-header">
                      <h4>Bifrost Peers</h4>
                      @if (getBifrostPeers(node).length) {
                        <span class="count-badge">{{ getBifrostPeers(node).length }}</span>
                      }
                      @if (getOrphanPeers(node).length) {
                        <button class="purge-btn" (click)="purgeOrphanPeers(node); $event.stopPropagation()" [disabled]="busyNodeId() === node.id">
                          <fa-icon [icon]="['fal', 'broom']" [fixedWidth]="true"></fa-icon>
                          Purge {{ getOrphanPeers(node).length }} orphan{{ getOrphanPeers(node).length > 1 ? 's' : '' }}
                        </button>
                      }
                    </div>
                    @if (getBifrostPeers(node).length) {
                      <div class="peer-list">
                        @for (peer of getBifrostPeers(node); track peer.id) {
                          <div class="peer-row">
                            <div class="peer-info">
                              <span class="peer-name">{{ peer.name.replace('bifrost-', '') }}</span>
                              <code class="mono-sm">{{ peer.ip }}</code>
                            </div>
                            <div class="peer-actions">
                              <span class="status-pill" [class.active]="peer.enabled" [class.disabled]="!peer.enabled">
                                {{ peer.enabled ? 'Active' : 'Disabled' }}
                              </span>
                              <button class="peer-delete-btn" (click)="deletePeerFromNode(node.id, peer.id, peer.name); $event.stopPropagation()" title="Delete peer from spark">
                                <fa-icon [icon]="['fal', 'trash-can']" [fixedWidth]="true"></fa-icon>
                              </button>
                            </div>
                          </div>
                        }
                      </div>
                    } @else {
                      <div class="empty-hint">
                        {{ node.status === 'online' ? 'No peers configured' : 'Spark offline — no data available' }}
                      </div>
                    }
                  </div>
                </div>
              }
            </div>
          }
        </div>
      }
      @if (nodes().length === 0) {
        <div class="empty-state">No sparks yet — click "Add Spark" to get started</div>
      }

      @if (contextMenu(); as menu) {
        <div class="ctx-backdrop" (click)="closeMenu()" (contextmenu)="$event.preventDefault(); closeMenu()"></div>
        <div class="ctx-menu" [style.left.px]="menu.x" [style.top.px]="menu.y">
          @for (item of menu.items; track item.label) {
            <button class="ctx-item" [class.danger]="item.danger" (click)="runMenuItem(item)">{{ item.label }}</button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .page-header h2 { margin: 0; font-size: 1.1rem; color: var(--text-primary); font-weight: 600; }
    .btn-primary { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.5rem 1rem; background: var(--accent); color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 0.8rem; font-weight: 500; transition: background 0.15s ease; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-secondary { padding: 0.5rem 1rem; background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); border-radius: 8px; cursor: pointer; font-size: 0.8rem; }

    .overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center; z-index: 1000; }
    .dialog { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 16px; padding: 1.5rem; width: 380px; }
    .dialog h3 { margin: 0 0 1rem; color: var(--text-primary); font-size: 1rem; }
    .field { margin-bottom: 1rem; }
    .field label { display: block; font-size: 0.7rem; font-weight: 500; color: var(--text-tertiary); margin-bottom: 0.35rem; text-transform: uppercase; letter-spacing: 0.3px; }
    .field input { width: 100%; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; box-sizing: border-box; }
    .field input:focus { outline: none; border-color: var(--accent); }
    .error-msg { background: color-mix(in srgb, var(--error) 10%, transparent); color: var(--error); font-size: 0.8rem; padding: 0.5rem 0.75rem; border-radius: 8px; margin-bottom: 1rem; }
    .dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
    .dialog-wide { width: 560px; max-width: calc(100vw - 3rem); }
    .dialog-hint { margin: 0 0 1rem; font-size: 0.8rem; line-height: 1.5; color: var(--text-tertiary); }
    .dialog-hint.dim { margin: 0.75rem 0 1.25rem; color: var(--text-disabled); }
    .copy-row { display: flex; gap: 0.5rem; }
    .copy-row input { flex: 1; min-width: 0; padding: 0.6rem 0.75rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
    .btn-copy { flex-shrink: 0; display: flex; align-items: center; gap: 0.4rem; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.78rem; cursor: pointer; transition: border-color 0.15s ease, color 0.15s ease; }
    .btn-copy:hover { border-color: var(--accent); color: var(--accent); }
    .dim-note { color: var(--text-disabled); font-size: 0.7rem; }
    .field-sm label.inline { display: flex; align-items: center; gap: 0.5rem; text-transform: none; letter-spacing: 0; font-size: 0.75rem; color: var(--text-tertiary); }
    .field-sm label.inline input { width: auto; }

    /* Node cards */
    .nodes-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .node-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; transition: border-color 0.15s ease; }
    .node-card.expanded { border-color: color-mix(in srgb, var(--accent) 40%, var(--border)); }
    .node-card.row-busy { opacity: 0.6; pointer-events: none; }

    .node-header { display: flex; align-items: center; padding: 0.75rem 1rem; cursor: pointer; gap: 1rem; transition: background 0.1s ease; }
    .node-header:hover { background: color-mix(in srgb, var(--sidebar-hover) 50%, transparent); }
    .node-info { display: flex; align-items: center; gap: 0.6rem; flex: 1; min-width: 0; }
    .expand-icon { color: var(--text-disabled); font-size: 0.75rem; width: 14px; flex-shrink: 0; }
    .cell-primary { font-weight: 500; color: var(--text-primary); font-size: 0.85rem; cursor: text; }
    .cell-primary:hover { text-decoration: underline; text-decoration-style: dashed; text-underline-offset: 3px; text-decoration-color: var(--text-disabled); }
    .cell-secondary { font-size: 0.65rem; color: var(--text-disabled); margin-top: 1px; font-family: monospace; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
    .inline-rename { background: var(--bg-input); border: 1px solid var(--accent); border-radius: 4px; padding: 2px 6px; color: var(--text-primary); font-size: 0.85rem; font-weight: 500; outline: none; width: 160px; }
    .geo-label { color: var(--accent); font-family: inherit; font-size: 0.6rem; }
    .wan-ip { color: var(--text-disabled); font-size: 0.6rem; }
    .version-label { color: var(--text-disabled); font-size: 0.6rem; font-family: ui-monospace, monospace; }
    .update-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.62rem; font-weight: 600; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .owner-badge { display: flex; align-items: center; gap: 0.25rem; flex-shrink: 0; }
    .owner-label { font-size: 0.6rem; color: var(--text-disabled); background: var(--bg-input); padding: 2px 8px; border-radius: 6px; }
    .unassign-btn { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: none; border: none; color: var(--text-disabled); cursor: pointer; font-size: 0.55rem; border-radius: 4px; transition: all 0.15s ease; }
    .unassign-btn:hover { color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
    .assign-btn { display: inline-flex; align-items: center; gap: 0.25rem; padding: 2px 8px; background: none; border: 1px dashed var(--text-disabled); color: var(--text-disabled); border-radius: 6px; cursor: pointer; font-size: 0.6rem; transition: all 0.15s ease; }
    .assign-btn:hover { border-color: var(--accent); color: var(--accent); }
    .select-field { width: 100%; padding: 0.6rem 0.8rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.85rem; }
    .select-field:focus { outline: none; border-color: var(--accent); }
    .shared-pill { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 0.55rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; background: color-mix(in srgb, #8b5cf6 15%, transparent); color: #8b5cf6; }
    .node-header.shared { cursor: default; }
    .node-card:has(.node-header.shared) { border-left: 3px solid #8b5cf6; }
    .share-list { margin-bottom: 0.75rem; }
    .share-row { display: flex; align-items: center; justify-content: space-between; padding: 0.35rem 0; font-size: 0.8rem; color: var(--text-secondary); border-bottom: 1px solid var(--border); }
    .share-add { display: flex; gap: 0.4rem; margin-bottom: 1rem; }
    .share-input { flex: 1; padding: 0.5rem 0.75rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-size: 0.8rem; }
    .share-input:focus { outline: none; border-color: var(--accent); }
    .btn-sm-inline { padding: 0.5rem 0.75rem; font-size: 0.75rem; }
    .isp-label { color: var(--text-tertiary); font-family: inherit; font-size: 0.6rem; }
    .speed-label { color: var(--success); font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: 0.65rem; white-space: nowrap; }
    .speed-sep { margin: 0 0.4rem; opacity: 0.5; }
    .speed-unit { margin-left: 0.35rem; color: var(--text-tertiary); }

    .node-badges { display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .role-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.65rem; font-weight: 500; background: var(--bg-input); color: var(--text-tertiary); }
    .role-pill.primary { background: var(--accent); color: #fff; }
    .status-cell { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: var(--text-secondary); }
    .status-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .status-dot.online { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .status-dot.offline { background: var(--text-disabled); }
    .status-dot.pending { background: var(--warning, #f59e0b); }
    .status-dot.paused { background: var(--warning, #f59e0b); box-shadow: none; }

    .adopt-btn { display: inline-flex; align-items: center; gap: 0.35rem; padding: 4px 12px; border-radius: 10px; font-size: 0.65rem; font-weight: 600; border: 1px solid var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); color: var(--success); cursor: pointer; transition: all 0.15s ease; text-transform: uppercase; letter-spacing: 0.3px; }
    .adopt-btn:hover:not(:disabled) { background: color-mix(in srgb, var(--success) 25%, transparent); }
    .adopt-btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .adoption-pill { display: inline-block; padding: 2px 10px; border-radius: 10px; font-size: 0.6rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }
    .adoption-pill[data-status="pending"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }
    .adoption-pill[data-status="available"] { background: color-mix(in srgb, #3b82f6 15%, transparent); color: #3b82f6; }
    .adoption-pill[data-status="adopted"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .adoption-pill[data-status="revoked"] { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); }

    .node-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .action-btn { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; background: none; border: 1px solid var(--border); color: var(--text-tertiary); border-radius: 6px; cursor: pointer; transition: all 0.15s ease; }
    .action-btn:hover { background: var(--sidebar-hover); color: var(--text-primary); }
    .action-btn.warning:hover { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); border-color: var(--warning, #f59e0b); }
    .action-btn.resume { color: var(--success); border-color: color-mix(in srgb, var(--success) 45%, transparent); }
    .action-btn.resume:hover { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); border-color: var(--success); }
    .action-btn.danger:hover { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); border-color: var(--error); }

    /* Expand panel */
    .node-panel { border-top: 1px solid var(--border); background: var(--bg-secondary); }
    .panel-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border); padding: 0 1rem; }
    .tab { display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.6rem 1rem; background: none; border: none; border-bottom: 2px solid transparent; color: var(--text-disabled); font-size: 0.75rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
    .tab:hover { color: var(--text-secondary); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
    .tab-content { padding: 1rem 1.25rem; }
    .panel-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .edit-grid .full { grid-column: 1 / -1; }
    .panel-section h4 { margin: 0 0 0.65rem; font-size: 0.7rem; font-weight: 600; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.5px; }

    .info-row { display: flex; justify-content: space-between; align-items: center; padding: 0.3rem 0; font-size: 0.8rem; }
    .info-label { color: var(--text-disabled); font-size: 0.75rem; }
    .info-value { color: var(--text-primary); font-size: 0.8rem; }
    .info-value.mono { font-family: monospace; font-size: 0.75rem; }
    .info-row.error { margin-top: 0.5rem; }
    .error-text { color: var(--error); font-size: 0.75rem; }

    .sync-pill { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 0.65rem; font-weight: 500; }
    .sync-pill[data-state="synced"] { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .sync-pill[data-state="applying"] { background: color-mix(in srgb, #3b82f6 15%, transparent); color: #3b82f6; }
    .sync-pill[data-state="error"] { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); }
    .sync-pill[data-state="drift"] { background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent); color: var(--warning, #f59e0b); }

    /* Edit form */
    .edit-form { display: flex; flex-direction: column; gap: 0.5rem; }
    .field-sm label { display: block; font-size: 0.65rem; color: var(--text-disabled); margin-bottom: 0.2rem; text-transform: uppercase; letter-spacing: 0.3px; }
    .field-sm input { width: 100%; padding: 0.4rem 0.6rem; background: var(--bg-input); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); font-size: 0.8rem; box-sizing: border-box; }
    .field-sm input:focus { outline: none; border-color: var(--accent); }
    .field-hint { display: block; font-size: 0.65rem; color: var(--text-disabled); margin-top: 0.2rem; }
    .edit-actions { display: flex; gap: 0.4rem; justify-content: flex-end; margin-top: 0.25rem; }
    .edit-btn { margin-top: 0.5rem; }

    .btn-sm { display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.75rem; font-weight: 500; cursor: pointer; border: none; transition: all 0.15s ease; }
    .btn-sm.primary { background: var(--accent); color: #fff; }
    .btn-sm.primary:hover { background: var(--accent-hover); }
    .btn-sm.primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-sm.secondary { background: var(--bg-input); color: var(--text-secondary); border: 1px solid var(--border); }
    .btn-sm.secondary:hover { background: var(--sidebar-hover); }
    .btn-sm.accent { background: color-mix(in srgb, var(--accent) 15%, transparent); color: var(--accent); border: 1px solid var(--accent); }
    .btn-sm.accent:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); }

    .panel-actions { display: flex; flex-direction: column; gap: 0.4rem; }

    .spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinning { animation: spin 0.8s linear infinite; }

    /* UniFi sections */
    .unifi-section { margin-bottom: 1.25rem; }
    .unifi-test { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; padding: 0.45rem 0.65rem; border-radius: 6px; font-size: 0.75rem; }
    .unifi-test.ok { color: var(--success, #22c55e); background: color-mix(in srgb, var(--success, #22c55e) 10%, transparent); }
    .unifi-test.fail { color: var(--danger, #ef4444); background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent); }
    .unifi-section:last-child { margin-bottom: 0; }
    .section-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
    .section-header h4 { margin: 0; font-size: 0.7rem; font-weight: 600; color: var(--text-disabled); text-transform: uppercase; letter-spacing: 0.5px; }
    .count-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--accent); color: #fff; font-size: 0.6rem; font-weight: 600; }

    .vpn-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.5rem; margin-top: 0.5rem; }
    .vpn-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; padding: 0.65rem 0.85rem; }
    .vpn-card.dimmed { background: color-mix(in srgb, var(--text-tertiary) 5%, var(--bg-surface)); }
    .vpn-card.dimmed .vpn-name { color: var(--text-secondary); }
    .peer-list.compact { margin-top: 0.5rem; padding-top: 0.4rem; border-top: 1px solid var(--border); gap: 0.15rem; }
    .peer-list.compact .peer-row { padding: 0.15rem 0; }
    .peer-empty { margin-top: 0.4rem; font-size: 0.7rem; color: var(--text-tertiary); font-style: italic; }
    .icon-btn { display: inline-flex; align-items: center; justify-content: center; padding: 3px; background: transparent; border: none; border-radius: 5px; color: var(--text-tertiary); cursor: pointer; font-size: 0.7rem; transition: all 0.15s ease; }
    .icon-btn:hover { background: color-mix(in srgb, var(--text-tertiary) 15%, transparent); color: var(--text-secondary); }
    .icon-btn.danger:hover { background: color-mix(in srgb, var(--danger, #ef4444) 15%, transparent); color: var(--danger, #ef4444); }
    .icon-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .cmd-pending { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.7rem; color: var(--accent); }
    .cmd-error { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.72rem; color: var(--danger, #ef4444); background: color-mix(in srgb, var(--danger, #ef4444) 10%, transparent); }
    .add-client { margin-top: 0.5rem; gap: 0.3rem; }
    .config-panel { margin-top: 0.6rem; border: 1px solid var(--accent); border-radius: 8px; background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface)); padding: 0.6rem 0.75rem; }
    .config-head { display: flex; align-items: center; justify-content: space-between; font-size: 0.75rem; font-weight: 600; color: var(--accent); margin-bottom: 0.4rem; }
    .config-body { margin: 0; padding: 0.5rem 0.6rem; background: var(--bg-base, var(--bg-surface)); border-radius: 6px; font-size: 0.68rem; line-height: 1.5; overflow-x: auto; white-space: pre; color: var(--text-secondary); }
    .config-actions { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
    .freshness { font-size: 0.66rem; color: var(--text-tertiary); }
    .disabled-pill { display: inline-block; padding: 1px 7px; border-radius: 8px; font-size: 0.55rem; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; background: color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent); color: var(--warning, #f59e0b); }
    .ctx-backdrop { position: fixed; inset: 0; z-index: 1000; }
    .ctx-menu { position: fixed; z-index: 1001; min-width: 150px; padding: 0.25rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.25); display: flex; flex-direction: column; }
    .ctx-item { display: block; width: 100%; text-align: left; padding: 0.4rem 0.6rem; background: transparent; border: none; border-radius: 5px; color: var(--text-primary); font-size: 0.78rem; cursor: pointer; }
    .ctx-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .ctx-item.danger { color: var(--danger, #ef4444); }
    .ctx-item.danger:hover { background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent); }
    .vpn-card.spark-vpn { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 5%, var(--bg-surface)); }
    .spark-vpn-badge { display: flex; align-items: center; gap: 0.4rem; color: var(--accent); }
    .spark-vpn-badge .vpn-name { color: var(--accent); font-weight: 600; }
    .spark-pill { display: inline-block; padding: 2px 8px; border-radius: 8px; font-size: 0.55rem; font-weight: 700; letter-spacing: 1px; background: var(--accent); color: #fff; }
    .vpn-pending { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.4rem; font-size: 0.75rem; color: var(--accent); }
    .vpn-pending.waiting { color: var(--text-tertiary); }
    .wait-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--warning); animation: pulse 1.4s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
    .create-tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; border: 2px dashed color-mix(in srgb, var(--accent) 40%, transparent); background: color-mix(in srgb, var(--accent) 5%, transparent); color: var(--accent); font-size: 0.8rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; min-height: 80px; }
    .create-tile:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); border-color: var(--accent); }
    .create-tile:disabled { opacity: 0.5; cursor: not-allowed; }
    .create-tile.disabled { border-color: color-mix(in srgb, var(--text-disabled) 40%, transparent); background: transparent; color: var(--text-disabled); }
    .create-tile.disabled:hover { background: transparent; border-color: color-mix(in srgb, var(--text-disabled) 40%, transparent); }
    .create-hint { font-size: 0.65rem; font-weight: 400; color: var(--text-disabled); }
    .vpn-card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.4rem; }
    .vpn-card-actions { display: flex; align-items: center; gap: 0.4rem; }
    .vpn-missing { margin-top: 0.4rem; font-size: 0.72rem; color: var(--warning); }
    .vpn-name { font-weight: 600; font-size: 0.85rem; color: var(--text-primary); }
    .vpn-port { font-family: monospace; font-size: 0.75rem; color: var(--text-disabled); }
    .vpn-details { display: flex; flex-direction: column; gap: 0.25rem; }
    .vpn-detail { display: flex; justify-content: space-between; align-items: center; }
    .mono-sm { font-family: monospace; font-size: 0.7rem; color: var(--text-secondary); }
    .truncate { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .peer-list { display: flex; flex-direction: column; gap: 0.25rem; }
    .peer-row { display: flex; align-items: center; justify-content: space-between; padding: 0.4rem 0.65rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 6px; }
    .peer-info { display: flex; align-items: center; gap: 0.75rem; }
    .peer-name { font-weight: 500; font-size: 0.8rem; color: var(--text-primary); }
    .peer-actions { display: flex; align-items: center; gap: 0.5rem; }
    .peer-delete-btn { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: none; border: 1px solid transparent; color: var(--text-disabled); border-radius: 4px; cursor: pointer; font-size: 0.7rem; transition: all 0.15s ease; }
    .peer-delete-btn:hover { color: var(--error); border-color: var(--error); background: color-mix(in srgb, var(--error) 10%, transparent); }
    .purge-btn { display: inline-flex; align-items: center; gap: 0.3rem; padding: 3px 10px; background: color-mix(in srgb, var(--error) 8%, transparent); border: 1px solid color-mix(in srgb, var(--error) 30%, transparent); border-radius: 6px; color: var(--error); font-size: 0.65rem; font-weight: 500; cursor: pointer; transition: all 0.15s ease; margin-left: auto; }
    .purge-btn:hover { background: color-mix(in srgb, var(--error) 18%, transparent); border-color: var(--error); }
    .purge-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-pill { display: inline-block; padding: 1px 8px; border-radius: 8px; font-size: 0.6rem; font-weight: 500; }
    .status-pill.active { background: color-mix(in srgb, var(--success) 15%, transparent); color: var(--success); }
    .status-pill.disabled { background: var(--bg-input); color: var(--text-disabled); }

    .empty-hint { font-size: 0.75rem; color: var(--text-disabled); padding: 0.5rem 0; }

    .empty-state { text-align: center; color: var(--text-disabled); padding: 2.5rem; background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; }
  `],
})
export class NodesPage implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly ws = inject(WsService);
  private readonly confirm = inject(ConfirmService);
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubWs: (() => void) | null = null;

  devices = signal<{ name: string }[]>([]);
  userList = signal<{ email: string; displayName: string; groups: readonly string[] }[]>([]);
  assignNodeId = signal<string | null>(null);
  assignEmail = '';
  shareNodeId = signal<string | null>(null);
  shareList = signal<{ email: string }[]>([]);
  shareableUsers = signal<{ email: string; displayName: string; groups: readonly string[]; createdBy: string | null }[]>([]);
  shareEmail = '';

  nodes = signal<NodeRow[]>([]);
  showAddDialog = signal(false);
  newNodeName = '';
  addingNode = signal(false);
  addError = signal('');
  busyNodeId = signal<string | null>(null);
  expandedNodeId = signal<string | null>(null);
  activeTab = signal<PanelTab>('status');
  renamingNodeId = signal<string | null>(null);
  renameValue = '';
  editingNodeId = signal<string | null>(null);
  editForm: NodeEdit = { name: '', controllerUrl: '', tunnelUrl: '', tunnelId: '', priority: 100 };
  editingUnifiId = signal<string | null>(null);
  unifiForm: UnifiEdit = {
    controllerUrl: '',
    controllerApiKey: '',
    unifiHost: '',
    unifiPort: 443,
    unifiSite: 'default',
    unifiUsername: '',
    unifiPassword: '',
    unifiApiKey: '',
    unifiInsecure: true,
    endpointOverride: '',
  };

  /** The one-liner shown in the install dialog; null when the dialog is closed. */
  installCmd = signal<string | null>(null);
  copied = signal(false);
  copiedNodeId = signal<string | null>(null);

  /**
   * The install/update command for a spark.
   *
   * With an adoption code while the spark is still pending; without one once it's
   * adopted — at that point the installer reads its own install.conf and an update
   * needs no code. Minting a fresh code is `reinstall()`, never this.
   */
  private installCommandFor(code: string | null): string {
    const base =
      'curl -fsSL https://raw.githubusercontent.com/ASCtheone/bifrost/master/scripts/install-spark.sh | sh';
    return code ? `${base} -s -- ${code}` : base;
  }

  selectAll(e: Event): void {
    (e.target as HTMLInputElement).select();
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard needs a secure context; the field is readonly + select-on-focus,
      // so it stays copyable by hand when this is blocked.
      return;
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  async copyInstall(node: NodeRow): Promise<void> {
    await this.copy(this.installCommandFor(node.adoptionCode));
    this.copiedNodeId.set(node.id);
    setTimeout(() => this.copiedNodeId.set(null), 2000);
  }

  /**
   * Mint a fresh adoption code so this spark can be installed from scratch again.
   * Destructive — it drops the current node key, so a running spark stops until it
   * re-registers. Hence the confirm, and hence it is not what the copy button does.
   */
  async reinstall(node: NodeRow): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Reinstall spark?',
      message:
        `This issues a new adoption code for "${node.name}" and revokes its current key. ` +
        `The running spark will stop working until it is reinstalled and re-adopted. ` +
        `To simply update an existing spark, use the copy button instead — no new code is needed.`,
      confirmLabel: 'Issue new code',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(node.id, async () => {
      const res = await this.api.post<{ adoptionCode: string }>(`/nodes/${node.id}/reissue-code`);
      this.installCmd.set(this.installCommandFor(res.adoptionCode));
    });
  }

  ngOnInit(): void {
    this.fetchNodes();
    this.fetchDevices();
  }

  private async fetchDevices(): Promise<void> {
    try {
      const res = await this.api.get<{ devices: { name: string }[] }>('/devices');
      this.devices.set(res.devices);
    } catch { /* ignore */ }
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.unsubWs?.();
  }

  private async fetchNodes(): Promise<void> {
    try {
      const res = await this.api.get<NodesResponse>('/nodes');
      this.nodes.set([...res.nodes]);
    } catch (err) {
      console.error('[nodes] fetch failed:', err);
    }
  }

  toggleExpand(nodeId: string): void {
    if (this.expandedNodeId() === nodeId) {
      this.expandedNodeId.set(null);
    } else {
      this.expandedNodeId.set(nodeId);
      this.activeTab.set('status');
    }
    this.editingNodeId.set(null);
    this.editingUnifiId.set(null);
  }

  startRename(node: NodeRow): void {
    this.renameValue = node.name;
    this.renamingNodeId.set(node.id);
  }

  async saveRename(nodeId: string): Promise<void> {
    if (!this.renameValue.trim()) {
      this.renamingNodeId.set(null);
      return;
    }
    await this.withBusy(nodeId, async () => {
      await this.api.put(`/nodes/${nodeId}`, { name: this.renameValue.trim() });
      this.renamingNodeId.set(null);
    });
  }

  startEdit(node: NodeRow): void {
    this.editForm = {
      name: node.name,
      controllerUrl: node.controllerUrl,
      tunnelUrl: node.tunnelUrl,
      tunnelId: node.tunnelId,
      priority: node.priority,
    };
    this.editingNodeId.set(node.id);
  }

  cancelEdit(): void {
    this.editingNodeId.set(null);
  }

  startUnifiEdit(node: NodeRow): void {
    this.unifiForm = {
      controllerUrl: node.controllerUrl,
      controllerApiKey: '',
      unifiHost: node.unifiHost,
      unifiPort: node.unifiPort || 443,
      unifiSite: node.unifiSite || 'default',
      unifiUsername: node.unifiUsername,
      // Never prefilled — the server doesn't send secrets back. Blank = leave as-is.
      unifiPassword: '',
      unifiApiKey: '',
      unifiInsecure: node.unifiInsecure,
      endpointOverride: node.endpointOverride,
    };
    this.editingUnifiId.set(node.id);
  }

  cancelUnifiEdit(): void {
    this.editingUnifiId.set(null);
  }

  formatTime(iso: string): string {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return d.toLocaleDateString();
  }

  formatDate(iso: string): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString();
  }

  // ── Actions with busy guard ───────────────────────────────────

  private async withBusy(nodeId: string, action: () => Promise<void>): Promise<void> {
    if (this.busyNodeId()) return;
    this.busyNodeId.set(nodeId);
    try {
      await action();
      await this.fetchNodes();
      await this.fetchDevices();
    } catch (err) {
      console.error('[nodes] action failed:', err);
    } finally {
      this.busyNodeId.set(null);
    }
  }

  async addNode(): Promise<void> {
    this.addError.set('');
    this.addingNode.set(true);
    try {
      // The server mints an adoption code here. Surface it as a ready-to-run install
      // command — previously this response was discarded and the code was only
      // reachable by downloading a JSON file and reading it by hand.
      const res = await this.api.post<{ adoptionCode: string }>('/nodes', {
        name: this.newNodeName || undefined,
      });
      this.showAddDialog.set(false);
      this.newNodeName = '';
      this.installCmd.set(this.installCommandFor(res.adoptionCode));
      await this.fetchNodes();
    } catch (err) {
      this.addError.set(err instanceof Error ? err.message : 'Failed to create node');
    } finally {
      this.addingNode.set(false);
    }
  }

  async downloadConfig(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      const config = await this.api.get<Record<string, unknown>>(`/nodes/${nodeId}/config`);
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bifrost-config-${nodeId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  async adoptNode(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/adopt`);
    });
  }

  async saveNode(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.put(`/nodes/${nodeId}`, this.editForm);
      this.editingNodeId.set(null);
    });
  }

  async deletePeerFromNode(nodeId: string, peerId: string, peerName: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete Peer',
      message: `Delete peer "${peerName.replace('bifrost-', '')}" from this spark?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/delete-peer`, { peerId });
    });
  }

  isAdmin(): boolean {
    return this.auth.isAdmin();
  }

  async showAssignDialog(nodeId: string): Promise<void> {
    try {
      const res = await this.api.get<{ users: { email: string; displayName: string; groups: readonly string[] }[] }>('/users');
      this.userList.set(res.users.filter(u => u.groups.includes('admin') || u.groups.includes('superadmin')));
    } catch { /* ignore */ }
    this.assignEmail = '';
    this.assignNodeId.set(nodeId);
  }

  async assignSpark(): Promise<void> {
    const nodeId = this.assignNodeId();
    if (!nodeId || !this.assignEmail) return;
    await this.withBusy(nodeId, async () => {
      await this.api.put(`/nodes/${nodeId}`, { assignToEmail: this.assignEmail });
      this.assignNodeId.set(null);
    });
  }

  async openShareDialog(nodeId: string): Promise<void> {
    this.shareEmail = '';
    this.shareNodeId.set(nodeId);
    try {
      const [sharesRes, usersRes] = await Promise.all([
        this.api.get<{ shares: { email: string }[] }>(`/nodes/${nodeId}/shares`),
        this.api.get<{ users: { email: string; displayName: string; groups: readonly string[]; createdBy: string | null }[] }>('/users'),
      ]);
      this.shareList.set(sharesRes.shares);
      const alreadyShared = new Set(sharesRes.shares.map(s => s.email));
      const myEmail = this.auth.user()?.email ?? '';
      const isSuperadmin = this.auth.isSuperadmin();
      // Superadmin: can share with anyone
      // Admin: can share with other admins + own users (not other admin's users)
      this.shareableUsers.set(
        usersRes.users.filter(u => {
          if (alreadyShared.has(u.email)) return false;
          if (u.email === myEmail) return false;
          if (isSuperadmin) return true;
          // Allow other admins
          if (u.groups.includes('admin') || u.groups.includes('superadmin')) return true;
          // Allow own users (createdBy matches)
          if (u.createdBy === myEmail) return true;
          // Allow users with no owner
          if (!u.createdBy) return true;
          return false;
        }),
      );
    } catch {
      this.shareList.set([]);
      this.shareableUsers.set([]);
    }
  }

  async addShare(): Promise<void> {
    const nodeId = this.shareNodeId();
    if (!nodeId || !this.shareEmail) return;
    try {
      await this.api.post(`/nodes/${nodeId}/share`, { email: this.shareEmail });
      this.shareEmail = '';
      const res = await this.api.get<{ shares: { email: string }[] }>(`/nodes/${nodeId}/shares`);
      this.shareList.set(res.shares);
    } catch (err) {
      console.error('[nodes] share failed:', err);
    }
  }

  async removeSpark(email: string): Promise<void> {
    const nodeId = this.shareNodeId();
    if (!nodeId) return;
    try {
      await this.api.post(`/nodes/${nodeId}/share`, { email, action: 'remove' });
      const res = await this.api.get<{ shares: { email: string }[] }>(`/nodes/${nodeId}/shares`);
      this.shareList.set(res.shares);
    } catch (err) {
      console.error('[nodes] unshare failed:', err);
    }
  }

  async unassignSpark(nodeId: string, name: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Unassign Spark',
      message: `Remove owner from "${name}"?`,
      confirmLabel: 'Unassign',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(nodeId, async () => {
      await this.api.put(`/nodes/${nodeId}`, { assignToEmail: null });
    });
  }

  getOrphanPeers(node: NodeRow): VpnPeer[] {
    const bifrostPeers = this.getBifrostPeers(node);
    if (!bifrostPeers.length) return [];
    // A peer is orphan if its name (minus "bifrost-") doesn't match any device name
    const deviceNames = new Set(this.devices().map(d => d.name));
    return bifrostPeers.filter(p => !deviceNames.has(p.name.replace('bifrost-', '')));
  }

  async purgeOrphanPeers(node: NodeRow): Promise<void> {
    const orphans = this.getOrphanPeers(node);
    if (!orphans.length) return;
    const ok = await this.confirm.confirm({
      title: 'Purge Orphan Peers',
      message: `Delete ${orphans.length} orphan peer${orphans.length > 1 ? 's' : ''} from "${node.name}"? These peers don't match any Bifrost device.`,
      confirmLabel: 'Purge',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(node.id, async () => {
      for (const peer of orphans) {
        await this.api.post(`/nodes/${node.id}/delete-peer`, { peerId: peer.id });
      }
    });
  }

  getBifrostPeers(node: NodeRow): VpnPeer[] {
    if (!node.actualConfig?.peers) return [];
    return node.actualConfig.peers.filter(p => p.name.startsWith('bifrost-'));
  }

  isSparkVpn(node: NodeRow): boolean {
    return !!node.sparkVpnName;
  }

  isSparkServer(node: NodeRow, server: VpnServer): boolean {
    // Match the spark-owned server by id first (the authoritative binding), then by name
    // for pre-id state — mirrors the control plane's spark_server_for.
    if (node.sparkVpnId && server.id === node.sparkVpnId) return true;
    return !!node.sparkVpnName && server.name === node.sparkVpnName;
  }

  getSparkServer(node: NodeRow): VpnServer | null {
    const servers = node.actualConfig?.servers;
    if (!servers) return null;
    return servers.find((s) => this.isSparkServer(node, s)) ?? null;
  }

  async createVpn(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/create-vpn`);
    });
  }

  // Re-provision the spark's VPN server: unbinds the current one and asks the spark to
  // create a fresh server. Needed when the server was deleted on the controller, or to
  // recover from a VPN bound to the wrong instance.
  async recreateVpn(node: NodeRow): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Recreate Spark VPN',
      message: `Provision a fresh WireGuard server for "${node.name}"? The spark will create a new server; devices re-address onto it automatically. Any peers on the old server are left behind.`,
      confirmLabel: 'Recreate',
      danger: true,
    });
    if (!ok) return;
    await this.createVpn(node.id);
  }

  // ── WireGuard server CRUD (queued to the spark) ──────────────────

  // Create a new server with an auto-picked 10.13.x subnet + port. Rename afterward.
  async addServer(node: NodeRow): Promise<void> {
    await this.withBusy(node.id, async () => {
      await this.api.post(`/nodes/${node.id}/servers`, {});
    });
  }

  async renameServer(node: NodeRow, server: VpnServer): Promise<void> {
    const name = window.prompt('New name for this VPN server:', server.name)?.trim();
    if (!name || name === server.name) return;
    await this.withBusy(node.id, async () => {
      await this.api.put(`/nodes/${node.id}/servers/${server.id}`, { name });
    });
  }

  async deleteServer(node: NodeRow, server: VpnServer): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete VPN Server',
      message: `Delete "${server.name}" and all its clients from the controller? This can't be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(node.id, async () => {
      await this.api.delete(`/nodes/${node.id}/servers/${server.id}`);
    });
  }

  // Whether a management command is queued/in-flight for this node.
  hasPendingCommands(node: NodeRow): boolean {
    return !!node.pendingCommands?.length;
  }

  // Failed command results, newest surfaced so the user sees why an op didn't take.
  failedCommands(node: NodeRow): readonly { id: string; kind: string; error?: string }[] {
    return (node.commandResults ?? []).filter((r) => !r.ok).map((r) => ({ id: r.id, kind: '', error: r.error }));
  }

  // ── Client/peer CRUD (queued to the spark) ───────────────────────

  async addPeer(node: NodeRow, server: VpnServer): Promise<void> {
    const name = window.prompt('Client name:', 'client')?.trim();
    if (!name) return;
    await this.withBusy(node.id, async () => {
      await this.api.post(`/nodes/${node.id}/servers/${server.id}/peers`, { name });
    });
  }

  async renamePeer(node: NodeRow, server: VpnServer, peer: VpnPeer): Promise<void> {
    const name = window.prompt('New client name:', peer.name)?.trim();
    if (!name || name === peer.name) return;
    // publicKey + ip preserve the client's keypair and address across the rename.
    await this.withBusy(node.id, async () => {
      await this.api.put(`/nodes/${node.id}/servers/${server.id}/peers/${peer.id}`, {
        name,
        publicKey: peer.publicKey,
        ip: peer.ip,
      });
    });
  }

  async deletePeer(node: NodeRow, server: VpnServer, peer: VpnPeer): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete Client',
      message: `Delete "${peer.name}" from "${server.name}"?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(node.id, async () => {
      await this.api.delete(`/nodes/${node.id}/servers/${server.id}/peers/${peer.id}`);
    });
  }

  // The dashboard builds the client .conf from a create result carrying a generated
  // private key, plus the server's public key/port and the node's dial-in endpoint.
  private dismissedConfigs = signal<Set<string>>(new Set());

  generatedConfig(node: NodeRow): { id: string; label: string; config: string } | null {
    const r = (node.commandResults ?? []).find(
      (x) => x.ok && x.peer?.privateKey && !this.dismissedConfigs().has(x.id),
    );
    if (!r?.peer) return null;
    const server = node.actualConfig?.servers?.find((s) => s.id === r.peer!.serverId);
    if (!server || !node.endpoint) return null;
    const p = r.peer;
    const config = [
      '[Interface]',
      `PrivateKey = ${p.privateKey}`,
      `Address = ${p.ip}/32`,
      'DNS = 1.1.1.1',
      '',
      '[Peer]',
      `PublicKey = ${server.publicKey}`,
      `Endpoint = ${node.endpoint}:${server.serverPort}`,
      'AllowedIPs = 0.0.0.0/0',
      'PersistentKeepalive = 25',
      '',
    ].join('\n');
    return { id: r.id, label: p.ip, config };
  }

  dismissConfig(id: string): void {
    this.dismissedConfigs.update((s) => new Set(s).add(id));
  }

  async copyConfig(config: string): Promise<void> {
    await navigator.clipboard.writeText(config);
  }

  downloadClientConfig(cfg: { label: string; config: string }): void {
    const blob = new Blob([cfg.config], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bifrost-${cfg.label}.conf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Right-click context menus ────────────────────────────────────

  contextMenu = signal<{ x: number; y: number; items: MenuItemT[] } | null>(null);

  openServerMenu(ev: MouseEvent, node: NodeRow, server: VpnServer): void {
    ev.preventDefault();
    ev.stopPropagation();
    const items: MenuItemT[] = [
      { label: 'Add client', run: () => this.addPeer(node, server) },
      { label: 'Rename server', run: () => this.renameServer(node, server) },
    ];
    if (this.isSparkServer(node, server)) {
      items.push({ label: 'Recreate now', run: () => this.quickRecreate(node) });
    }
    items.push({ label: 'Delete server', danger: true, run: () => this.deleteServer(node, server) });
    this.contextMenu.set({ x: ev.clientX, y: ev.clientY, items });
  }

  // The spark card renders even with no bound server (deleted): offer recreate then.
  openSparkMenu(ev: MouseEvent, node: NodeRow): void {
    const server = this.getSparkServer(node);
    if (server) {
      this.openServerMenu(ev, node, server);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    this.contextMenu.set({
      x: ev.clientX,
      y: ev.clientY,
      items: [{ label: 'Recreate now', run: () => this.quickRecreate(node) }],
    });
  }

  openPeerMenu(ev: MouseEvent, node: NodeRow, server: VpnServer, peer: VpnPeer): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.contextMenu.set({
      x: ev.clientX,
      y: ev.clientY,
      items: [
        { label: 'Rename client', run: () => this.renamePeer(node, server, peer) },
        { label: 'Delete client', danger: true, run: () => this.deletePeer(node, server, peer) },
      ],
    });
  }

  closeMenu(): void {
    this.contextMenu.set(null);
  }

  runMenuItem(item: MenuItemT): void {
    this.closeMenu();
    void item.run();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.closeMenu();
  }

  // Recreate the spark VPN with no confirmation — the "quick recreate" the operator asked
  // for when they just want a fresh server immediately.
  async quickRecreate(node: NodeRow): Promise<void> {
    await this.createVpn(node.id);
  }

  // Human "scanned N ago" from the last heartbeat, so the operator knows how fresh the
  // inventory is (the spark reports the full controller state every cycle).
  lastSeenAgo(node: NodeRow): string {
    if (!node.lastSeen) return 'never';
    const secs = Math.max(0, Math.floor((Date.now() - new Date(node.lastSeen).getTime()) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
    return `${Math.floor(secs / 3600)}h ago`;
  }

  async pauseNode(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/pause`);
    });
  }

  async resumeNode(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/resume`);
    });
  }

  async refreshNode(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.get(`/nodes`);
    });
  }

  // Whether the spark has a usable UniFi controller configured (host + a credential).
  // Mirrors the control plane's desired-config gate; used to block VPN creation.
  unifiConfigured(node: NodeRow): boolean {
    return !!node.unifiHost && (node.hasUnifiApiKey || node.hasUnifiPassword);
  }

  // The result of the last "Test connection", keyed to the node it ran on.
  unifiTest = signal<{ nodeId: string; ok: boolean; message: string } | null>(null);

  // Test the UniFi connection. The spark is what actually reaches the controller (over the
  // local network — the control plane can't), and it reports the outcome on each heartbeat,
  // so the test reflects the spark's most recent check after a refresh.
  async testUnifi(node: NodeRow): Promise<void> {
    this.unifiTest.set(null);
    await this.withBusy(node.id, async () => { /* withBusy re-fetches the nodes */ });
    const n = this.nodes().find((x) => x.id === node.id) ?? node;
    let res: { ok: boolean; message: string };
    if (!this.unifiConfigured(n)) {
      res = { ok: false, message: 'No controller configured — set a host and API key first.' };
    } else if (n.status !== 'online') {
      res = { ok: false, message: 'Spark is offline — bring it online, then test again.' };
    } else if (n.error) {
      res = { ok: false, message: n.error };
    } else {
      const c = n.actualConfig?.servers?.length ?? 0;
      res = { ok: true, message: `Connected — ${c} WireGuard server${c === 1 ? '' : 's'} on the controller.` };
    }
    this.unifiTest.set({ nodeId: node.id, ...res });
  }

  async saveUnifi(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      const f = this.unifiForm;
      const payload: Record<string, string | number | boolean> = {
        // Empty string clears the override → back to the auto-detected address.
        endpointOverride: f.endpointOverride,
        unifiHost: f.unifiHost,
        unifiPort: Number(f.unifiPort) || 443,
        unifiSite: f.unifiSite || 'default',
        unifiUsername: f.unifiUsername,
        unifiInsecure: f.unifiInsecure,
      };
      // Only send a secret when the user actually typed one. Omitting it leaves the
      // stored value alone — otherwise saving any other field (say, the port) would
      // blank out the credential.
      if (f.unifiApiKey) {
        payload['unifiApiKey'] = f.unifiApiKey;
      }
      if (f.unifiPassword) {
        payload['unifiPassword'] = f.unifiPassword;
      }
      if (f.controllerApiKey) {
        payload['controllerApiKey'] = f.controllerApiKey;
      }
      await this.api.put(`/nodes/${nodeId}`, payload);
      this.editingUnifiId.set(null);
    });
  }

  async promote(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.put(`/nodes/${nodeId}/role`, { role: 'primary' });
    });
  }

  async forceResync(nodeId: string): Promise<void> {
    await this.withBusy(nodeId, async () => {
      await this.api.post('/force-resync', { nodeId });
    });
  }

  async revokeNode(nodeId: string, name: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Revoke Spark Key',
      message: `Revoke key for "${name}"? The agent will stop working.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(nodeId, async () => {
      await this.api.post(`/nodes/${nodeId}/revoke`);
    });
  }

  async remove(nodeId: string, name: string): Promise<void> {
    const ok = await this.confirm.confirm({
      title: 'Delete Spark',
      message: `Delete spark "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.withBusy(nodeId, async () => {
      await this.api.delete(`/nodes/${nodeId}`);
    });
  }
}
