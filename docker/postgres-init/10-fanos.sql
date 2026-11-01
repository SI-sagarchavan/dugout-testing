-- The pipeline's control-plane database, beside dugout's `harness` in the same server (ADR 0021).
-- Runs once, when the data directory is first created. On a server that already exists, run
-- scripts/pipeline-db.sh instead. REPLICATION is for Electric, which reads the WAL as this role;
-- it is not a superuser, so the pipeline cannot reach `harness`.
CREATE ROLE fanos LOGIN REPLICATION PASSWORD 'fanos';
CREATE DATABASE fanos OWNER fanos;
-- the API's integration tests wipe their database, so they get one of their own
CREATE DATABASE fanos_test OWNER fanos;
