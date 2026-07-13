-- Device-code pairing: a device (e.g. a GL.iNet router) generates a short code
-- on first boot; a signed-in user then claims it in the dashboard, which ties a
-- device to their account and hands back the provision token (delivered to the
-- device via its callback URL, or fetched by the device polling the code).
--
-- Optional device expiry lets a registration lapse unless reset from the UI.

ALTER TABLE devices ADD COLUMN expires_at TEXT;

CREATE TABLE IF NOT EXISTS device_codes (
    code            TEXT PRIMARY KEY,               -- e.g. XZK4-7QWR
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | registered | consumed
    device_id       TEXT,                            -- set on registration
    provision_token TEXT,                            -- set on registration
    owner_email     TEXT,                            -- who claimed it
    callback_url    TEXT,                            -- device's local callback (optional)
    name            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT '',
    code_expires_at TEXT NOT NULL DEFAULT ''         -- pending-code TTL (~15 min)
);
