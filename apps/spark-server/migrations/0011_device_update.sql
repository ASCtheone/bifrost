-- Remote router (openwrt-client) self-update, driven through the device's /provision poll.
--
-- The router reports its version + whether it has a rollback backup on each poll, and the
-- master hands back a one-shot `pending_action` (update/revert) that the dashboard sets.
-- Fire-once: the provision handler clears it as it returns it, so a missed poll just means
-- the operator clicks again — no retry loop that could fight a failing update.

ALTER TABLE devices ADD COLUMN client_version   TEXT;
ALTER TABLE devices ADD COLUMN pending_action    TEXT;                 -- 'update' | 'revert' | null
ALTER TABLE devices ADD COLUMN device_backup_available INTEGER NOT NULL DEFAULT 0;
