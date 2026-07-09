-- Manual pause: an admin can pause a spark, which makes the control plane treat
-- it as offline (no work is dispatched to it) regardless of heartbeats, until
-- it is resumed. This is an operator override, distinct from a crashed/stale node.
ALTER TABLE nodes ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
