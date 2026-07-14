-- Optional WireGuard endpoint override.
--
-- The endpoint a device dials is normally automatic: the spark's public IPv4, as
-- observed by the control plane from the source address of each heartbeat. This
-- column overrides that, for a site with a DDNS name or a static address.
--
-- NOT backfilled from `controller_url`. That column was surfaced in the UI as
-- "Controller URL" and, despite being copied into devices.server_endpoint, was read by
-- nothing — so it never affected a config. Its values are therefore whatever people
-- believed a "controller URL" was (typically a private LAN address like
-- https://192.168.1.1). Promoting those to live WireGuard endpoints would hand every
-- device an unreachable address. Anyone who wants an override sets it deliberately.

ALTER TABLE nodes ADD COLUMN endpoint_override TEXT NOT NULL DEFAULT '';
