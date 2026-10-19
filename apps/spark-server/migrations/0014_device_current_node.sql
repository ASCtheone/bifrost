-- The spark the router's tunnel is up on, reported on each /provision poll
-- (X-Bifrost-Current header; empty while the tunnel is down or in safe mode).
-- Drives "connected via <spark>" on the dashboard's device card.
ALTER TABLE devices ADD COLUMN current_node_id TEXT;
