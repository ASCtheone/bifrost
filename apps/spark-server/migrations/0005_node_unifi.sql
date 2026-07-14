-- UniFi controller settings, per spark, configured from the dashboard.
--
-- Until now the spark read these from a local bifrost-spark.toml, which meant
-- installing one required hand-editing a file on the box. They now live here and
-- are served to the spark (node-key auth) so the whole thing is configured in the UI.
--
-- The password is stored ENCRYPTED (XChaCha20-Poly1305, see src/crypto.rs) — it is
-- a controller admin credential, and the database ends up in backups and on disks.
-- `unifi_password_enc` holds base64(nonce || ciphertext), never the plaintext.
--
-- Note: `controller_url` (0001_init) is NOT this. Despite the name it is used as the
-- WireGuard server endpoint when building device configs, so it is left alone.

ALTER TABLE nodes ADD COLUMN unifi_host TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN unifi_port INTEGER NOT NULL DEFAULT 443;
ALTER TABLE nodes ADD COLUMN unifi_site TEXT NOT NULL DEFAULT 'default';
ALTER TABLE nodes ADD COLUMN unifi_username TEXT NOT NULL DEFAULT '';
ALTER TABLE nodes ADD COLUMN unifi_password_enc TEXT;
ALTER TABLE nodes ADD COLUMN unifi_insecure INTEGER NOT NULL DEFAULT 1;
