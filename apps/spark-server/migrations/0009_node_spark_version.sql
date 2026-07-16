-- The spark's self-reported running version, from each heartbeat. Compared against the
-- control plane's own version to flag when an update is available (and, later, to drive
-- the per-spark update button).

ALTER TABLE nodes ADD COLUMN spark_version TEXT;
