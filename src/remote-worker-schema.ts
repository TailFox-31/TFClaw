import type { Database } from 'bun:sqlite';

export function ensureRemoteWorkerSchema(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      worker_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      capability_tokens_json TEXT NOT NULL,
      max_concurrency INTEGER NOT NULL DEFAULT 1,
      last_heartbeat_at TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      version TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      CHECK (status IN ('idle', 'busy', 'offline', 'draining'))
    );
    CREATE INDEX IF NOT EXISTS idx_workers_status_heartbeat
      ON workers(status, last_heartbeat_at);

    CREATE TABLE IF NOT EXISTS jobs (
      job_id TEXT PRIMARY KEY,
      workspace_key TEXT NOT NULL,
      session_key TEXT,
      session_policy TEXT NOT NULL DEFAULT 'fresh',
      repo_url TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      mode TEXT NOT NULL,
      prompt TEXT NOT NULL,
      required_tokens_json TEXT NOT NULL DEFAULT '[]',
      target_files_json TEXT NOT NULL DEFAULT '[]',
      artifact_policy_json TEXT NOT NULL DEFAULT '{}',
      timeout_sec INTEGER NOT NULL DEFAULT 1800,
      priority INTEGER NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'queued',
      max_attempts INTEGER NOT NULL DEFAULT 3,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      assigned_worker_id TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      cancel_reason TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      result_summary TEXT,
      result_json TEXT,
      CHECK (session_policy IN ('fresh', 'prefer_reuse', 'require_reuse')),
      CHECK (mode IN ('edit', 'review', 'build', 'test', 'unity_batch')),
      CHECK (status IN ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_priority_created
      ON jobs(status, priority, created_at);

    CREATE TABLE IF NOT EXISTS job_attempts (
      attempt_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_no INTEGER NOT NULL,
      worker_id TEXT NOT NULL,
      lease_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      started_at TEXT,
      last_heartbeat_at TEXT NOT NULL,
      interrupt_deadline_at TEXT,
      finished_at TEXT,
      exit_code INTEGER,
      failure_code TEXT,
      failure_message TEXT,
      result_summary TEXT,
      result_json TEXT,
      UNIQUE(job_id, attempt_no),
      CHECK (status IN ('claimed', 'running', 'completed', 'failed', 'lost', 'cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_job_attempts_job_status
      ON job_attempts(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_job_attempts_worker_status
      ON job_attempts(worker_id, status);

    CREATE TABLE IF NOT EXISTS workspace_locks (
      workspace_key TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      worker_id TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      last_heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      artifact_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      attempt_id TEXT,
      kind TEXT NOT NULL,
      storage_type TEXT NOT NULL,
      locator TEXT NOT NULL,
      size_bytes INTEGER,
      sha256 TEXT,
      content_type TEXT,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      CHECK (kind IN ('stdout', 'stderr', 'patch', 'diff', 'screenshot', 'build_output', 'report', 'archive')),
      CHECK (storage_type IN ('inline', 'local_file', 'remote_url'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_job_kind
      ON artifacts(job_id, kind);

    CREATE TABLE IF NOT EXISTS worker_sessions (
      worker_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      opaque_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (worker_id, session_key, provider),
      CHECK (provider IN ('codex', 'claude-code')),
      CHECK (status IN ('active', 'stale', 'closed'))
    );
    CREATE INDEX IF NOT EXISTS idx_worker_sessions_lookup
      ON worker_sessions(session_key, provider, status, last_used_at);
  `);
}
