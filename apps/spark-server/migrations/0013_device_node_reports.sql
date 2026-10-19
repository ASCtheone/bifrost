-- The router's last WireGuard handshake result per spark, reported by the
-- openwrt-client on each /provision poll (X-Bifrost-Nodes header) as JSON
-- {nodeId: {"ok": bool, "at": iso}}. The only ground truth for "can this router
-- actually reach that spark" — everything else the control plane checks is config.
ALTER TABLE devices ADD COLUMN node_reports TEXT;
