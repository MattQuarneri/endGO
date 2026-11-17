-- Shared logical schema for Cloud/cloudflare.ts.
-- Apply with Wrangler migrations when CloudflareAdapter.autoMigrate is false.

CREATE TABLE IF NOT EXISTS cloud_subjects (
  subject TEXT PRIMARY KEY,
  revision TEXT NOT NULL,
  manifest TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_records (
  ref TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_records_subject ON cloud_records(subject);

CREATE TABLE IF NOT EXISTS cloud_objects (
  ref TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  expires_at INTEGER,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_objects_subject ON cloud_objects(subject);

CREATE TABLE IF NOT EXISTS cloud_cache_entries (
  ref TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  version TEXT NOT NULL,
  ephemeral INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_cache_entries_subject ON cloud_cache_entries(subject);

CREATE TABLE IF NOT EXISTS cloud_search (
  ref TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  document TEXT NOT NULL,
  fields TEXT NOT NULL,
  expires_at INTEGER,
  version TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS cloud_search_subject ON cloud_search(subject);

CREATE TABLE IF NOT EXISTS cloud_tombstones (
  ref TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_jobs (
  idempotency_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_jobs_job_id ON cloud_jobs(job_id);
