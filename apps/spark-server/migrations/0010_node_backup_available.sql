-- Whether the spark currently has a rollback binary staged (its .bak), reported on each
-- heartbeat. Drives the dashboard's Revert button.

ALTER TABLE nodes ADD COLUMN spark_backup_available INTEGER NOT NULL DEFAULT 0;
