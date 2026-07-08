-- Bifrost control-plane schema (ported from the DynamoDB single-table model).
-- GSIs become plain indexes; the IP-pool "allocated" map becomes a normalized
-- ip_allocations table with a UNIQUE(subnet_key, ip) constraint.

-- ── nodes ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS nodes (
    node_id                TEXT PRIMARY KEY,
    node_name              TEXT    NOT NULL DEFAULT '',
    owner_id               TEXT    NOT NULL DEFAULT '',
    owner_email            TEXT    NOT NULL DEFAULT '',
    status                 TEXT    NOT NULL DEFAULT 'offline',   -- online | offline
    role                   TEXT    NOT NULL DEFAULT 'secondary', -- primary | secondary
    priority               INTEGER NOT NULL DEFAULT 0,
    last_seen              TEXT    NOT NULL DEFAULT '',
    tunnel_url             TEXT    NOT NULL DEFAULT '',
    tunnel_id              TEXT    NOT NULL DEFAULT '',
    controller_url         TEXT    NOT NULL DEFAULT '',
    controller_api_key     TEXT,
    spark_vpn_name         TEXT,
    spark_vpn_id           TEXT,
    pending_vpn_create     INTEGER NOT NULL DEFAULT 0,
    sync_state             TEXT    NOT NULL DEFAULT 'synced',    -- synced | applying | error | drift
    last_applied_version   INTEGER NOT NULL DEFAULT 0,
    actual_config          TEXT,                                 -- JSON
    error                  TEXT,
    adoption_status        TEXT    NOT NULL DEFAULT 'pending',   -- pending | available | adopted | revoked
    adoption_code          TEXT,
    code_expires_at        TEXT,
    node_key_hash          TEXT,
    key_issued_at          TEXT,
    wan_ip                 TEXT,
    geo                    TEXT,                                 -- JSON
    isp_name               TEXT,
    speed_down             REAL,
    speed_up               REAL,
    speed_ping             REAL,
    pending_peer_deletions TEXT,                                 -- JSON array
    created_at             TEXT    NOT NULL DEFAULT '',
    updated_at             TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_nodes_adoption_code ON nodes(adoption_code);
CREATE INDEX IF NOT EXISTS idx_nodes_status        ON nodes(status, last_seen);
CREATE INDEX IF NOT EXISTS idx_nodes_role          ON nodes(role, priority);

-- ── pending_keys (short-lived adoption handoff) ──────────────────
CREATE TABLE IF NOT EXISTS pending_keys (
    node_id    TEXT PRIMARY KEY,
    raw_key    TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

-- ── devices (VPN clients) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
    device_id         TEXT PRIMARY KEY,
    node_id           TEXT    NOT NULL,
    name              TEXT    NOT NULL DEFAULT '',
    type              TEXT    NOT NULL DEFAULT 'laptop',
    status            TEXT    NOT NULL DEFAULT 'pending',
    provision_method  TEXT    NOT NULL DEFAULT 'url',
    provision_token   TEXT,
    assigned_ip       TEXT    NOT NULL DEFAULT '',
    public_key        TEXT    NOT NULL DEFAULT '',
    private_key       TEXT    NOT NULL DEFAULT '',
    preshared_key     TEXT    NOT NULL DEFAULT '',
    server_public_key TEXT    NOT NULL DEFAULT '',
    server_endpoint   TEXT    NOT NULL DEFAULT '',
    server_port       INTEGER NOT NULL DEFAULT 51820,
    dns               TEXT    NOT NULL DEFAULT '[]',
    allowed_ips       TEXT    NOT NULL DEFAULT '[]',
    unifi_peer_id     TEXT,
    enabled           INTEGER NOT NULL DEFAULT 1,
    last_seen         TEXT,
    created_by        TEXT    NOT NULL DEFAULT '',
    owner_email       TEXT    NOT NULL DEFAULT '',
    created_at        TEXT    NOT NULL DEFAULT '',
    updated_at        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_devices_node ON devices(node_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_token
    ON devices(provision_token) WHERE provision_token IS NOT NULL;

-- ── peers (WireGuard peers) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS peers (
    peer_id               TEXT PRIMARY KEY,
    name                  TEXT    NOT NULL DEFAULT '',
    server_id             TEXT    NOT NULL DEFAULT '',
    node_id               TEXT    NOT NULL DEFAULT '',
    unifi_peer_id         TEXT    NOT NULL DEFAULT '',
    public_key            TEXT    NOT NULL DEFAULT '',
    private_key_encrypted TEXT    NOT NULL DEFAULT '',
    preshared_key         TEXT,
    assigned_ip           TEXT    NOT NULL DEFAULT '',
    allowed_ips           TEXT    NOT NULL DEFAULT '[]',
    endpoint              TEXT    NOT NULL DEFAULT '',
    config_version        INTEGER NOT NULL DEFAULT 0,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_by            TEXT    NOT NULL DEFAULT '',
    created_at            TEXT    NOT NULL DEFAULT '',
    updated_at            TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_peers_server ON peers(server_id, enabled);
CREATE INDEX IF NOT EXISTS idx_peers_node   ON peers(node_id);

-- ── vpn_config (singleton) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS vpn_config (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    config_version INTEGER NOT NULL DEFAULT 1,
    server         TEXT    NOT NULL DEFAULT '{}',
    defaults       TEXT    NOT NULL DEFAULT '{}',
    updated_at     TEXT    NOT NULL DEFAULT '',
    updated_by     TEXT    NOT NULL DEFAULT ''
);

-- ── ip pools + normalized allocations ────────────────────────────
CREATE TABLE IF NOT EXISTS ip_pools (
    subnet_key      TEXT PRIMARY KEY,
    subnet          TEXT    NOT NULL,
    gateway         TEXT    NOT NULL,
    next_available  INTEGER NOT NULL DEFAULT 2,   -- .1 is gateway
    total_addresses INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ip_allocations (
    subnet_key TEXT NOT NULL,
    peer_id    TEXT NOT NULL,
    ip         TEXT NOT NULL,
    PRIMARY KEY (subnet_key, peer_id),
    UNIQUE (subnet_key, ip),
    FOREIGN KEY (subnet_key) REFERENCES ip_pools(subnet_key) ON DELETE CASCADE
);

-- ── system_config (singleton) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_config (
    id                           INTEGER PRIMARY KEY CHECK (id = 1),
    heartbeat_interval_seconds   INTEGER NOT NULL DEFAULT 30,
    stale_threshold_seconds      INTEGER NOT NULL DEFAULT 120,
    sync_timeout_seconds         INTEGER NOT NULL DEFAULT 60,
    max_retries                  INTEGER NOT NULL DEFAULT 10,
    drift_check_interval_seconds INTEGER NOT NULL DEFAULT 300,
    auto_promote_enabled         INTEGER NOT NULL DEFAULT 1,
    auto_promote_stale_seconds   INTEGER NOT NULL DEFAULT 120
);
INSERT OR IGNORE INTO system_config (id) VALUES (1);

-- ── audit_log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id        TEXT PRIMARY KEY,      -- ULID
    action    TEXT NOT NULL,
    actor     TEXT NOT NULL,
    target_id TEXT NOT NULL DEFAULT '',
    details   TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
