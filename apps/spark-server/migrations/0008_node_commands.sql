-- Management command queue for the spark.
--
-- The spark talks only outbound (it polls desired-config and reports via heartbeat), so
-- the dashboard can't call it directly. Management operations — create/update/delete a
-- WireGuard server or peer on the controller — are enqueued here as a JSON array of
-- command objects, handed to the spark in its desired-config, executed against UniFi, and
-- acknowledged on the next heartbeat (which removes them by id). This generalises the
-- existing `pending_peer_deletions` queue to arbitrary controller operations.
--
-- `command_results` holds the outcome of the most recently executed commands (id, ok,
-- error) so a failure is visible in the dashboard rather than lost — the same "make
-- silent failures loud" rule the rest of the spark path follows.

ALTER TABLE nodes ADD COLUMN pending_commands TEXT NOT NULL DEFAULT '[]'; -- JSON array
ALTER TABLE nodes ADD COLUMN command_results  TEXT NOT NULL DEFAULT '[]'; -- JSON array
