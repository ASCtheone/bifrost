-- Router safe-mode (unlock override) state, reported by the openwrt-client on each
-- /provision poll (X-Bifrost-Safemode header). Lets the dashboard show whether a router
-- is in safe mode and toggle it via a one-shot pending_action ('unlock' | 'resume').
ALTER TABLE devices ADD COLUMN safe_mode INTEGER NOT NULL DEFAULT 0;
