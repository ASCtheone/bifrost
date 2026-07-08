-- Local-auth tables. This self-hosted control plane replaces AWS Cognito with a
-- local identity store, so `users` holds credentials + roles directly. It also
-- folds in the old ad-hoc `UserOwnership` entity (owner_email) and adds the
-- `SparkShare` and `ConnectionLog` entities that had no dedicated store.

-- ── users (local identity; replaces Cognito) ─────────────────────
CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT PRIMARY KEY,                 -- ULID
    username      TEXT    NOT NULL UNIQUE,           -- login handle (Cognito "Username")
    email         TEXT    NOT NULL UNIQUE,
    display_name  TEXT    NOT NULL DEFAULT '',
    password_hash TEXT    NOT NULL,                  -- argon2id PHC string
    groups        TEXT    NOT NULL DEFAULT '[]',     -- JSON array: "admin" | "superadmin"
    enabled       INTEGER NOT NULL DEFAULT 1,
    status        TEXT    NOT NULL DEFAULT 'CONFIRMED', -- CONFIRMED | FORCE_CHANGE_PASSWORD (Cognito parity)
    owner_email   TEXT    NOT NULL DEFAULT '',       -- owning admin (old UserOwnership.ownerEmail)
    must_change   INTEGER NOT NULL DEFAULT 0,        -- temporary-password flag
    created_at    TEXT    NOT NULL DEFAULT '',
    updated_at    TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_owner ON users(owner_email);

-- ── spark_shares (a node shared with another user by email) ──────
CREATE TABLE IF NOT EXISTS spark_shares (
    node_id           TEXT NOT NULL,
    shared_with_email TEXT NOT NULL,
    shared_by_email   TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (node_id, shared_with_email),
    FOREIGN KEY (node_id) REFERENCES nodes(node_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_shares_email ON spark_shares(shared_with_email);

-- ── connection_logs (device connection events, 90-day TTL) ───────
CREATE TABLE IF NOT EXISTS connection_logs (
    device_id           TEXT NOT NULL,
    seq                 TEXT NOT NULL,               -- "{ISO-timestamp}#{hex}" — sorts newest-last lexically
    action              TEXT NOT NULL DEFAULT 'connect',
    connected_node_id   TEXT,
    connected_node_name TEXT,
    source_ip           TEXT NOT NULL DEFAULT 'unknown',
    location            TEXT,
    user_agent          TEXT NOT NULL DEFAULT 'unknown',
    user_email          TEXT,
    timestamp           TEXT NOT NULL DEFAULT '',
    expires_at          INTEGER NOT NULL DEFAULT 0,  -- epoch seconds; rows past this are pruned lazily
    PRIMARY KEY (device_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_conn_logs_device ON connection_logs(device_id, seq);
