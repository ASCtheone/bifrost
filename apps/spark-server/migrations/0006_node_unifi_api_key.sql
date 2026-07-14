-- UniFi API key, per spark.
--
-- Preferred over the admin username/password added in 0005: an API key is scoped and
-- can be revoked on its own, without rotating a human's console password, and it
-- needs no session or CSRF handling.
--
-- Encrypted at rest like the password (XChaCha20-Poly1305, see src/crypto.rs) —
-- base64(nonce || ciphertext), never plaintext.
--
-- Note this is NOT the existing `controller_api_key` column from 0001_init: that one
-- is stored in plaintext and is read by nothing. It's left alone rather than quietly
-- repurposed into a column that now holds a live credential.

ALTER TABLE nodes ADD COLUMN unifi_api_key_enc TEXT;
