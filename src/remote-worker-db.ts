import crypto from 'crypto';

import type { Database } from 'bun:sqlite';

import { getDatabaseHandle } from './db.js';
import type {
  RemoteWorkerArtifactKind,
  RemoteWorkerArtifactRow,
  RemoteWorkerArtifactStorageType,
  RemoteWorkerArtifactView,
  RemoteWorkerAttemptRow,
  RemoteWorkerAttemptStatus,
  RemoteWorkerAttemptView,
  RemoteWorkerJobMode,
  RemoteWorkerJobRow,
  RemoteWorkerJobStatus,
  RemoteWorkerJobView,
  RemoteWorkerProvider,
  RemoteWorkerRecord,
  RemoteWorkerSessionPolicy,
  RemoteWorkerSessionRow,
  RemoteWorkerStatus,
} from './remote-worker-types.js';

export const REMOTE_WORKER_HEARTBEAT_INTERVAL_SEC = 15;
export const REMOTE_WORKER_LEASE_TTL_SEC = 45;
export const REMOTE_WORKER_CANCEL_GRACE_SEC = 15;

const ACTIVE_ATTEMPT_STATUSES = ['claimed', 'running'] as const;
const ACTIVE_ATTEMPT_STATUS_SET = new Set<RemoteWorkerAttemptStatus>(
  ACTIVE_ATTEMPT_STATUSES,
);

export class RemoteWorkerError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface WorkerRegisterInput {
  worker_id: string;
  display_name: string;
  capability_tokens: string[];
  max_concurrency: number;
  version?: string;
  metadata?: Record<string, unknown>;
}

interface WorkerHeartbeatInput {
  status: RemoteWorkerStatus;
  running_attempt_ids: string[];
  metadata?: Record<string, unknown>;
}

interface JobCreateInput {
  workspace_key: string;
  session_key?: string;
  session_policy: RemoteWorkerSessionPolicy;
  repo_url: string;
  branch: string;
  base_commit: string;
  mode: RemoteWorkerJobMode;
  requirements: string[];
  prompt: string;
  target_files?: string[];
  artifact_policy?: Record<string, string>;
  timeout_sec: number;
  priority: number;
  max_attempts: number;
}

interface JobClaimResult {
  job: RemoteWorkerJobView;
  attempt: {
    attempt_id: string;
    lease_token: string;
    heartbeat_interval_sec: number;
    lease_ttl_sec: number;
  };
  session: {
    session_key: string | null;
    session_policy: RemoteWorkerSessionPolicy;
    resume: { provider: RemoteWorkerProvider; opaque_session_id: string } | null;
  };
}

interface AttemptStartInput {
  worker_id: string;
  provider: RemoteWorkerProvider;
  opaque_session_id: string;
  session_reused: boolean;
}

interface AttemptHeartbeatInput {
  worker_id: string;
  progress_phase?: string;
  progress_message?: string;
  session_touch?: boolean;
}

interface AttemptCompleteInput {
  worker_id: string;
  result_summary: string;
  result_json?: Record<string, unknown>;
}

interface AttemptFailInput {
  worker_id: string;
  failure_code: string;
  failure_message: string;
  retryable: boolean;
  result_json?: Record<string, unknown>;
}

interface AttemptCancelledInput {
  worker_id: string;
  result_summary?: string;
  result_json?: Record<string, unknown>;
}

interface ArtifactUploadInputBase {
  kind: RemoteWorkerArtifactKind;
  storage_type: RemoteWorkerArtifactStorageType;
  content_type: string;
  sha256?: string;
  size_bytes?: number;
  metadata?: Record<string, unknown>;
}

type ArtifactUploadInput =
  | (ArtifactUploadInputBase & {
      storage_type: 'inline';
      content_base64: string;
    })
  | (ArtifactUploadInputBase & {
      storage_type: 'remote_url';
      locator_url: string;
    });

export function registerRemoteWorker(input: WorkerRegisterInput) {
  const db = getDatabaseHandle();
  const now = nowIso();
  db.prepare(
    `INSERT INTO workers (
      worker_id, display_name, status, capability_tokens_json, max_concurrency,
      last_heartbeat_at, registered_at, version, metadata_json
    ) VALUES (?, ?, 'idle', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(worker_id) DO UPDATE SET
      display_name = excluded.display_name,
      capability_tokens_json = excluded.capability_tokens_json,
      max_concurrency = excluded.max_concurrency,
      last_heartbeat_at = excluded.last_heartbeat_at,
      version = excluded.version,
      metadata_json = excluded.metadata_json`,
  ).run(
    input.worker_id,
    input.display_name,
    stableJson(input.capability_tokens),
    input.max_concurrency,
    now,
    now,
    input.version || null,
    stableJson(input.metadata ?? {}),
  );

  return {
    worker_id: input.worker_id,
    status: getWorkerStatus(input.worker_id),
    heartbeat_interval_sec: REMOTE_WORKER_HEARTBEAT_INTERVAL_SEC,
    lease_ttl_sec: REMOTE_WORKER_LEASE_TTL_SEC,
  };
}

export function heartbeatRemoteWorker(
  workerId: string,
  input: WorkerHeartbeatInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const worker = requireWorker(workerId);
  const status =
    worker.status === 'draining' && input.status !== 'offline'
      ? 'draining'
      : input.status;
  db.prepare(
    `UPDATE workers
       SET status = ?,
           last_heartbeat_at = ?,
           metadata_json = ?
     WHERE worker_id = ?`,
  ).run(status, nowIso(), stableJson(input.metadata ?? {}), workerId);
  return {
    accepted: true,
    server_time: nowIso(),
    next_heartbeat_sec: REMOTE_WORKER_HEARTBEAT_INTERVAL_SEC,
    drain_requested: status === 'draining',
  };
}

export function setRemoteWorkerDrain(workerId: string, enabled: boolean) {
  const db = getDatabaseHandle();
  requireWorker(workerId);
  db.prepare(
    `UPDATE workers
       SET status = ?,
           last_heartbeat_at = ?
     WHERE worker_id = ?`,
  ).run(enabled ? 'draining' : inferNonOfflineWorkerStatus(workerId), nowIso(), workerId);
  return {
    worker_id: workerId,
    status: getWorkerStatus(workerId),
  };
}

export function createRemoteWorkerJob(input: JobCreateInput) {
  const db = getDatabaseHandle();
  validateSessionPolicy(input.session_policy, input.session_key);
  const now = nowIso();
  const jobId = `job_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO jobs (
      job_id, workspace_key, session_key, session_policy, repo_url, branch,
      base_commit, mode, prompt, required_tokens_json, target_files_json,
      artifact_policy_json, timeout_sec, priority, status, max_attempts, attempt_count,
      assigned_worker_id, cancel_requested, cancel_reason, created_at,
      claimed_at, started_at, finished_at, result_summary, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0, NULL, 0, NULL, ?, NULL, NULL, NULL, NULL, NULL)`,
  ).run(
    jobId,
    input.workspace_key,
    input.session_key || null,
    input.session_policy,
    input.repo_url,
    input.branch,
    input.base_commit,
    input.mode,
    input.prompt,
    stableJson(input.requirements),
    stableJson(input.target_files ?? []),
    stableJson(input.artifact_policy ?? {}),
    input.timeout_sec,
    input.priority,
    input.max_attempts,
    now,
  );
  return {
    job_id: jobId,
    status: 'queued' as const,
  };
}

export function claimRemoteWorkerJob(workerId: string): JobClaimResult | null {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  requireWorker(workerId);

  return withImmediateTransaction(db, () => {
    const worker = requireWorker(workerId);
    if (worker.status === 'offline') {
      throw new RemoteWorkerError(
        'state_conflict',
        409,
        'Offline worker cannot claim jobs.',
      );
    }

    const activeCount = getActiveAttemptCount(workerId);
    if (activeCount >= worker.max_concurrency) {
      throw new RemoteWorkerError(
        'state_conflict',
        409,
        'Worker is already at max concurrency.',
      );
    }

    const capabilities = parseStringArray(worker.capability_tokens_json);
    const queuedJobs = db
      .prepare(
        `SELECT *
           FROM jobs
          WHERE status = 'queued'
          ORDER BY priority ASC, created_at ASC, job_id ASC`,
      )
      .all() as RemoteWorkerJobRow[];
    let blockedByWorkspaceLock = false;

    for (const jobRow of queuedJobs) {
      const requirements = parseStringArray(jobRow.required_tokens_json);
      if (!requirements.every((token) => capabilities.includes(token))) {
        continue;
      }

      const workspaceLock = db
        .prepare(
          `SELECT workspace_key
             FROM workspace_locks
            WHERE workspace_key = ?`,
        )
        .get(jobRow.workspace_key) as { workspace_key: string } | undefined;
      if (workspaceLock) {
        blockedByWorkspaceLock = true;
        continue;
      }

      const sessionResume =
        jobRow.session_policy === 'fresh'
          ? null
          : resolveSessionResume(workerId, jobRow);
      if (jobRow.session_policy === 'require_reuse' && !sessionResume) {
        continue;
      }

      const now = nowIso();
      const attemptId = `att_${crypto.randomUUID()}`;
      const leaseToken = crypto.randomBytes(18).toString('base64url');
      const attemptNo = jobRow.attempt_count + 1;

      db.prepare(
        `INSERT INTO job_attempts (
          attempt_id, job_id, attempt_no, worker_id, lease_token, status,
          claimed_at, started_at, last_heartbeat_at, interrupt_deadline_at,
          finished_at, exit_code, failure_code, failure_message, result_summary, result_json
        ) VALUES (?, ?, ?, ?, ?, 'claimed', ?, NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run(attemptId, jobRow.job_id, attemptNo, workerId, leaseToken, now, now);

      db.prepare(
        `UPDATE jobs
           SET status = 'claimed',
               attempt_count = ?,
               assigned_worker_id = ?,
               claimed_at = ?,
               started_at = NULL,
               finished_at = NULL,
               result_summary = NULL,
               result_json = NULL
         WHERE job_id = ?`,
      ).run(attemptNo, workerId, now, jobRow.job_id);

      db.prepare(
        `INSERT INTO workspace_locks (
          workspace_key, attempt_id, worker_id, acquired_at, last_heartbeat_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        jobRow.workspace_key,
        attemptId,
        workerId,
        now,
        now,
        addSeconds(now, REMOTE_WORKER_LEASE_TTL_SEC),
      );

      db.prepare(
        `UPDATE workers
           SET status = 'busy',
               last_heartbeat_at = ?
         WHERE worker_id = ?`,
      ).run(now, workerId);

      const refreshedJob = requireJob(jobRow.job_id);
      return {
        job: toJobView(refreshedJob),
        attempt: {
          attempt_id: attemptId,
          lease_token: leaseToken,
          heartbeat_interval_sec: REMOTE_WORKER_HEARTBEAT_INTERVAL_SEC,
          lease_ttl_sec: REMOTE_WORKER_LEASE_TTL_SEC,
        },
        session: {
          session_key: refreshedJob.session_key,
          session_policy: refreshedJob.session_policy,
          resume: sessionResume,
        },
      };
    }

    if (blockedByWorkspaceLock) {
      throw new RemoteWorkerError(
        'workspace_locked',
        423,
        'Matching workspaces are currently locked by active attempts.',
      );
    }

    return null;
  });
}

export function startRemoteWorkerAttempt(
  attemptId: string,
  leaseToken: string,
  input: AttemptStartInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  if (ctx.attempt.worker_id !== input.worker_id) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Attempt is assigned to a different worker.',
    );
  }
  if (ctx.attempt.status !== 'claimed') {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Only claimed attempts can be started.',
    );
  }

  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'running',
             started_at = ?,
             last_heartbeat_at = ?
       WHERE attempt_id = ?`,
    ).run(now, now, attemptId);

    db.prepare(
      `UPDATE jobs
         SET status = 'running',
             started_at = ?
       WHERE job_id = ?`,
    ).run(now, ctx.job.job_id);

    if (ctx.job.session_key) {
      db.prepare(
        `INSERT INTO worker_sessions (
          worker_id, session_key, provider, opaque_session_id, status, last_used_at, metadata_json
        ) VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(worker_id, session_key, provider) DO UPDATE SET
          opaque_session_id = excluded.opaque_session_id,
          status = 'active',
          last_used_at = excluded.last_used_at`,
      ).run(
        input.worker_id,
        ctx.job.session_key,
        input.provider,
        input.opaque_session_id,
        now,
        stableJson({ session_reused: input.session_reused }),
      );
    }
  })();

  return { status: 'running' as const };
}

export function heartbeatRemoteWorkerAttempt(
  attemptId: string,
  leaseToken: string,
  input: AttemptHeartbeatInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  if (ctx.attempt.worker_id !== input.worker_id) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Attempt is assigned to a different worker.',
    );
  }

  const now = nowIso();
  const leaseExpiresAt = addSeconds(now, REMOTE_WORKER_LEASE_TTL_SEC);

  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET last_heartbeat_at = ?
       WHERE attempt_id = ?`,
    ).run(now, attemptId);
    db.prepare(
      `UPDATE workspace_locks
         SET last_heartbeat_at = ?,
             expires_at = ?
       WHERE attempt_id = ?`,
    ).run(now, leaseExpiresAt, attemptId);
    db.prepare(
      `UPDATE workers
         SET last_heartbeat_at = ?,
             status = CASE WHEN status = 'draining' THEN 'draining' ELSE 'busy' END
       WHERE worker_id = ?`,
    ).run(now, input.worker_id);

    if (input.session_touch && ctx.job.session_key) {
      db.prepare(
        `UPDATE worker_sessions
           SET last_used_at = ?
         WHERE worker_id = ?
           AND session_key = ?
           AND status = 'active'`,
      ).run(now, input.worker_id, ctx.job.session_key);
    }
  })();

  const refreshedJob = requireJob(ctx.job.job_id);
  const refreshedAttempt = requireAttempt(attemptId);

  return {
    accepted: true,
    lease_expires_at: leaseExpiresAt,
    cancel_requested: refreshedJob.cancel_requested === 1,
    cancel_reason: refreshedJob.cancel_reason,
    interrupt_deadline_at: refreshedAttempt.interrupt_deadline_at,
  };
}

export function completeRemoteWorkerAttempt(
  attemptId: string,
  leaseToken: string,
  input: AttemptCompleteInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  if (ctx.attempt.worker_id !== input.worker_id) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Attempt is assigned to a different worker.',
    );
  }

  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'completed',
             finished_at = ?,
             result_summary = ?,
             result_json = ?
       WHERE attempt_id = ?`,
    ).run(now, input.result_summary, stableJson(input.result_json ?? {}), attemptId);

    db.prepare(
      `UPDATE jobs
         SET status = 'completed',
             finished_at = ?,
             result_summary = ?,
             result_json = ?,
             cancel_requested = 0,
             cancel_reason = NULL
       WHERE job_id = ?`,
    ).run(
      now,
      input.result_summary,
      stableJson(input.result_json ?? {}),
      ctx.job.job_id,
    );

    db.prepare(`DELETE FROM workspace_locks WHERE attempt_id = ?`).run(attemptId);
  })();

  syncWorkerStatus(input.worker_id);
  return { job_status: 'completed' as const };
}

export function failRemoteWorkerAttempt(
  attemptId: string,
  leaseToken: string,
  input: AttemptFailInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  if (ctx.attempt.worker_id !== input.worker_id) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Attempt is assigned to a different worker.',
    );
  }

  const now = nowIso();
  const shouldRequeue = input.retryable && ctx.job.attempt_count < ctx.job.max_attempts;

  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'failed',
             finished_at = ?,
             failure_code = ?,
             failure_message = ?,
             result_json = ?
       WHERE attempt_id = ?`,
    ).run(
      now,
      input.failure_code,
      input.failure_message,
      stableJson(input.result_json ?? {}),
      attemptId,
    );

    if (shouldRequeue) {
      db.prepare(
        `UPDATE jobs
           SET status = 'queued',
               assigned_worker_id = NULL,
               claimed_at = NULL,
               started_at = NULL,
               cancel_requested = 0,
               cancel_reason = NULL
         WHERE job_id = ?`,
      ).run(ctx.job.job_id);
    } else {
      db.prepare(
        `UPDATE jobs
           SET status = 'failed',
               finished_at = ?,
               result_summary = ?,
               result_json = ?,
               cancel_requested = 0,
               cancel_reason = NULL
         WHERE job_id = ?`,
      ).run(
        now,
        input.failure_message,
        stableJson(input.result_json ?? {}),
        ctx.job.job_id,
      );
    }

    db.prepare(`DELETE FROM workspace_locks WHERE attempt_id = ?`).run(attemptId);
  })();

  syncWorkerStatus(input.worker_id);
  return {
    job_status: shouldRequeue ? ('queued' as const) : ('failed' as const),
  };
}

export function cancelRemoteWorkerAttempt(
  attemptId: string,
  leaseToken: string,
  input: AttemptCancelledInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  if (ctx.attempt.worker_id !== input.worker_id) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Attempt is assigned to a different worker.',
    );
  }

  const now = nowIso();
  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'cancelled',
             finished_at = ?,
             result_summary = ?,
             result_json = ?
       WHERE attempt_id = ?`,
    ).run(
      now,
      input.result_summary || 'Cancelled by worker.',
      stableJson(input.result_json ?? {}),
      attemptId,
    );
    db.prepare(
      `UPDATE jobs
         SET status = 'cancelled',
             finished_at = ?,
             cancel_requested = 0,
             result_summary = ?,
             result_json = ?
       WHERE job_id = ?`,
    ).run(
      now,
      input.result_summary || 'Cancelled by worker.',
      stableJson(input.result_json ?? {}),
      ctx.job.job_id,
    );
    db.prepare(`DELETE FROM workspace_locks WHERE attempt_id = ?`).run(attemptId);
  })();

  syncWorkerStatus(input.worker_id);
  return { job_status: 'cancelled' as const };
}

export function uploadRemoteWorkerArtifact(
  attemptId: string,
  leaseToken: string,
  input: ArtifactUploadInput,
) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const ctx = requireLiveAttempt(attemptId, leaseToken);
  const artifactId = `art_${crypto.randomUUID()}`;
  const locator =
    input.storage_type === 'inline' ? input.content_base64 : input.locator_url;
  db.prepare(
    `INSERT INTO artifacts (
      artifact_id, job_id, attempt_id, kind, storage_type, locator, size_bytes,
      sha256, content_type, created_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    artifactId,
    ctx.job.job_id,
    attemptId,
    input.kind,
    input.storage_type,
    locator,
    input.size_bytes ?? null,
    input.sha256 ?? null,
    input.content_type,
    nowIso(),
    stableJson(input.metadata ?? {}),
  );

  return { artifact_id: artifactId };
}

export function requestRemoteWorkerJobCancel(jobId: string, reason: string) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const job = requireJob(jobId);
  const now = nowIso();

  if (job.status === 'queued') {
    db.prepare(
      `UPDATE jobs
         SET status = 'cancelled',
             cancel_requested = 0,
             cancel_reason = ?,
             finished_at = ?
       WHERE job_id = ?`,
    ).run(reason, now, jobId);
    return {
      job_status: 'cancelled' as const,
      cancel_requested: false,
      interrupt_deadline_at: null,
    };
  }

  if (job.status !== 'claimed' && job.status !== 'running') {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Only queued, claimed, or running jobs can be cancelled.',
    );
  }

  const activeAttempt = getActiveAttemptForJob(jobId);
  if (!activeAttempt) {
    throw new RemoteWorkerError(
      'state_conflict',
      409,
      'Job has no active attempt to cancel.',
    );
  }

  const deadline = addSeconds(now, REMOTE_WORKER_CANCEL_GRACE_SEC);
  db.transaction(() => {
    db.prepare(
      `UPDATE jobs
         SET cancel_requested = 1,
             cancel_reason = ?
       WHERE job_id = ?`,
    ).run(reason, jobId);
    db.prepare(
      `UPDATE job_attempts
         SET interrupt_deadline_at = ?
       WHERE attempt_id = ?`,
    ).run(deadline, activeAttempt.attempt_id);
  })();

  return {
    job_status: job.status,
    cancel_requested: true,
    interrupt_deadline_at: deadline,
  };
}

export function getRemoteWorkerJobStatus(jobId: string) {
  reapRemoteWorkerState();
  const db = getDatabaseHandle();
  const job = requireJob(jobId);
  const attempts = db
    .prepare(
      `SELECT *
         FROM job_attempts
        WHERE job_id = ?
        ORDER BY attempt_no ASC`,
    )
    .all(jobId) as RemoteWorkerAttemptRow[];
  const artifacts = db
    .prepare(
      `SELECT *
         FROM artifacts
        WHERE job_id = ?
        ORDER BY created_at ASC, artifact_id ASC`,
    )
    .all(jobId) as RemoteWorkerArtifactRow[];

  return {
    job: toJobView(job),
    latest_attempt:
      attempts.length > 0 ? toAttemptView(attempts[attempts.length - 1]) : null,
    artifacts: artifacts.map(toArtifactView),
    history_summary: attempts.map(toAttemptView),
  };
}

function reapRemoteWorkerState(): void {
  const db = getDatabaseHandle();
  const now = nowIso();

  const forcedCancellations = db
    .prepare(
      `SELECT attempt_id
         FROM job_attempts
        WHERE status IN ('claimed', 'running')
          AND interrupt_deadline_at IS NOT NULL
          AND interrupt_deadline_at <= ?`,
    )
    .all(now) as Array<{ attempt_id: string }>;

  for (const row of forcedCancellations) {
    forceCancelAttempt(row.attempt_id, now);
  }

  const leaseCutoff = new Date(
    Date.now() - REMOTE_WORKER_LEASE_TTL_SEC * 1000,
  ).toISOString();
  const expiredAttempts = db
    .prepare(
      `SELECT attempt_id
         FROM job_attempts
        WHERE status IN ('claimed', 'running')
          AND last_heartbeat_at <= ?
          AND (interrupt_deadline_at IS NULL OR interrupt_deadline_at > ?)`,
    )
    .all(leaseCutoff, now) as Array<{ attempt_id: string }>;

  for (const row of expiredAttempts) {
    markAttemptLost(row.attempt_id, now);
  }

  const offlineWorkers = db
    .prepare(
      `SELECT worker_id
         FROM workers
        WHERE last_heartbeat_at <= ?`,
    )
    .all(leaseCutoff) as Array<{ worker_id: string }>;

  for (const row of offlineWorkers) {
    db.prepare(
      `UPDATE workers
         SET status = 'offline'
       WHERE worker_id = ?`,
    ).run(row.worker_id);
  }
}

function forceCancelAttempt(attemptId: string, now: string): void {
  const db = getDatabaseHandle();
  const attempt = requireAttempt(attemptId);
  if (!ACTIVE_ATTEMPT_STATUS_SET.has(attempt.status)) {
    return;
  }
  const job = requireJob(attempt.job_id);

  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'cancelled',
             finished_at = ?,
             result_summary = 'Forced cancellation deadline exceeded.'
       WHERE attempt_id = ?`,
    ).run(now, attemptId);
    db.prepare(
      `UPDATE jobs
         SET status = 'cancelled',
             cancel_requested = 0,
             finished_at = ?,
             result_summary = 'Forced cancellation deadline exceeded.'
       WHERE job_id = ?`,
    ).run(now, job.job_id);
    db.prepare(`DELETE FROM workspace_locks WHERE attempt_id = ?`).run(attemptId);
  })();

  syncWorkerStatus(attempt.worker_id);
}

function markAttemptLost(attemptId: string, now: string): void {
  const db = getDatabaseHandle();
  const attempt = requireAttempt(attemptId);
  if (!ACTIVE_ATTEMPT_STATUS_SET.has(attempt.status)) {
    return;
  }
  const job = requireJob(attempt.job_id);
  const shouldRequeue = job.attempt_count < job.max_attempts;

  db.transaction(() => {
    db.prepare(
      `UPDATE job_attempts
         SET status = 'lost',
             finished_at = ?,
             failure_code = 'lease_expired',
             failure_message = 'Worker lease expired.'
       WHERE attempt_id = ?`,
    ).run(now, attemptId);

    if (shouldRequeue) {
      db.prepare(
        `UPDATE jobs
           SET status = 'queued',
               assigned_worker_id = NULL,
               claimed_at = NULL,
               started_at = NULL,
               cancel_requested = 0,
               cancel_reason = NULL
         WHERE job_id = ?`,
      ).run(job.job_id);
    } else {
      db.prepare(
        `UPDATE jobs
           SET status = 'failed',
               finished_at = ?,
               result_summary = 'Worker lease expired and attempts were exhausted.',
               cancel_requested = 0,
               cancel_reason = NULL
         WHERE job_id = ?`,
      ).run(now, job.job_id);
    }

    db.prepare(`DELETE FROM workspace_locks WHERE attempt_id = ?`).run(attemptId);
  })();

  syncWorkerStatus(attempt.worker_id);
}

function resolveSessionResume(
  workerId: string,
  job: RemoteWorkerJobRow,
): { provider: RemoteWorkerProvider; opaque_session_id: string } | null {
  if (!job.session_key) {
    return null;
  }
  const db = getDatabaseHandle();
  const inferredProvider = inferSessionProvider(parseStringArray(job.required_tokens_json));
  const row = inferredProvider
    ? (db
        .prepare(
          `SELECT *
             FROM worker_sessions
            WHERE worker_id = ?
              AND session_key = ?
              AND provider = ?
              AND status = 'active'
            ORDER BY last_used_at DESC
            LIMIT 1`,
        )
        .get(
          workerId,
          job.session_key,
          inferredProvider,
        ) as RemoteWorkerSessionRow | undefined)
    : (db
        .prepare(
          `SELECT *
             FROM worker_sessions
            WHERE worker_id = ?
              AND session_key = ?
              AND status = 'active'
            ORDER BY last_used_at DESC
            LIMIT 1`,
        )
        .get(workerId, job.session_key) as RemoteWorkerSessionRow | undefined);

  if (!row) {
    return null;
  }

  return {
    provider: row.provider,
    opaque_session_id: row.opaque_session_id,
  };
}

function inferSessionProvider(
  requirements: string[],
): RemoteWorkerProvider | null {
  if (requirements.includes('tool:codex')) {
    return 'codex';
  }
  if (requirements.includes('tool:claude-code')) {
    return 'claude-code';
  }
  return null;
}

function requireWorker(workerId: string): RemoteWorkerRecord {
  const db = getDatabaseHandle();
  const row = db
    .prepare(`SELECT * FROM workers WHERE worker_id = ?`)
    .get(workerId) as RemoteWorkerRecord | undefined;
  if (!row) {
    throw new RemoteWorkerError(
      'not_found',
      404,
      `Unknown worker: ${workerId}`,
    );
  }
  return row;
}

function requireJob(jobId: string): RemoteWorkerJobRow {
  const db = getDatabaseHandle();
  const row = db
    .prepare(`SELECT * FROM jobs WHERE job_id = ?`)
    .get(jobId) as RemoteWorkerJobRow | undefined;
  if (!row) {
    throw new RemoteWorkerError('not_found', 404, `Unknown job: ${jobId}`);
  }
  return row;
}

function requireAttempt(attemptId: string): RemoteWorkerAttemptRow {
  const db = getDatabaseHandle();
  const row = db
    .prepare(`SELECT * FROM job_attempts WHERE attempt_id = ?`)
    .get(attemptId) as RemoteWorkerAttemptRow | undefined;
  if (!row) {
    throw new RemoteWorkerError(
      'not_found',
      404,
      `Unknown attempt: ${attemptId}`,
    );
  }
  return row;
}

function requireLiveAttempt(attemptId: string, leaseToken: string): {
  attempt: RemoteWorkerAttemptRow;
  job: RemoteWorkerJobRow;
} {
  const attempt = requireAttempt(attemptId);
  if (attempt.lease_token !== leaseToken) {
    throw new RemoteWorkerError(
      'lease_expired',
      410,
      'Attempt lease token is stale.',
    );
  }
  if (!ACTIVE_ATTEMPT_STATUS_SET.has(attempt.status)) {
    throw new RemoteWorkerError(
      'lease_expired',
      410,
      'Attempt is no longer active.',
    );
  }
  return {
    attempt,
    job: requireJob(attempt.job_id),
  };
}

function getActiveAttemptForJob(
  jobId: string,
): RemoteWorkerAttemptRow | undefined {
  const db = getDatabaseHandle();
  return db
    .prepare(
      `SELECT *
         FROM job_attempts
        WHERE job_id = ?
          AND status IN ('claimed', 'running')
        ORDER BY attempt_no DESC
        LIMIT 1`,
    )
    .get(jobId) as RemoteWorkerAttemptRow | undefined;
}

function getActiveAttemptCount(workerId: string): number {
  const db = getDatabaseHandle();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM job_attempts
        WHERE worker_id = ?
          AND status IN ('claimed', 'running')`,
    )
    .get(workerId) as { count: number };
  return row.count;
}

function inferNonOfflineWorkerStatus(workerId: string): RemoteWorkerStatus {
  return getActiveAttemptCount(workerId) > 0 ? 'busy' : 'idle';
}

function syncWorkerStatus(workerId: string): void {
  const db = getDatabaseHandle();
  const worker = requireWorker(workerId);
  if (worker.status === 'offline') {
    return;
  }

  const nextStatus: RemoteWorkerStatus =
    worker.status === 'draining'
      ? 'draining'
      : inferNonOfflineWorkerStatus(workerId);

  db.prepare(
    `UPDATE workers
       SET status = ?,
           last_heartbeat_at = ?
     WHERE worker_id = ?`,
  ).run(nextStatus, nowIso(), workerId);
}

function getWorkerStatus(workerId: string): RemoteWorkerStatus {
  return requireWorker(workerId).status;
}

function toJobView(row: RemoteWorkerJobRow): RemoteWorkerJobView {
  return {
    job_id: row.job_id,
    workspace_key: row.workspace_key,
    session_key: row.session_key,
    session_policy: row.session_policy,
    repo_url: row.repo_url,
    branch: row.branch,
    base_commit: row.base_commit,
    mode: row.mode,
    requirements: parseStringArray(row.required_tokens_json),
    prompt: row.prompt,
    target_files: parseStringArray(row.target_files_json),
    artifact_policy: parseStringMap(row.artifact_policy_json),
    timeout_sec: row.timeout_sec,
    priority: row.priority,
    status: row.status,
    max_attempts: row.max_attempts,
    attempt_count: row.attempt_count,
    assigned_worker_id: row.assigned_worker_id,
    cancel_requested: row.cancel_requested === 1,
    cancel_reason: row.cancel_reason,
    created_at: row.created_at,
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    result_summary: row.result_summary,
    result_json: parseObject(row.result_json),
  };
}

function toAttemptView(row: RemoteWorkerAttemptRow): RemoteWorkerAttemptView {
  return {
    attempt_id: row.attempt_id,
    job_id: row.job_id,
    attempt_no: row.attempt_no,
    worker_id: row.worker_id,
    status: row.status,
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    last_heartbeat_at: row.last_heartbeat_at,
    interrupt_deadline_at: row.interrupt_deadline_at,
    finished_at: row.finished_at,
    exit_code: row.exit_code,
    failure_code: row.failure_code,
    failure_message: row.failure_message,
    result_summary: row.result_summary,
    result_json: parseObject(row.result_json),
  };
}

function toArtifactView(
  row: RemoteWorkerArtifactRow,
): RemoteWorkerArtifactView {
  return {
    artifact_id: row.artifact_id,
    job_id: row.job_id,
    attempt_id: row.attempt_id,
    kind: row.kind,
    storage_type: row.storage_type,
    locator: row.locator,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    content_type: row.content_type,
    created_at: row.created_at,
    metadata: parseObject(row.metadata_json) ?? {},
  };
}

function validateSessionPolicy(
  sessionPolicy: RemoteWorkerSessionPolicy,
  sessionKey?: string,
) {
  if (
    (sessionPolicy === 'prefer_reuse' || sessionPolicy === 'require_reuse') &&
    !sessionKey
  ) {
    throw new RemoteWorkerError(
      'validation_error',
      422,
      'session_key is required for reuse policies.',
    );
  }
}

function withImmediateTransaction<T>(database: Database, fn: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) {
    return [];
  }
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseStringMap(json: string | null): Record<string, string> {
  const value = parseObject(json);
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) {
    return null;
  }
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function addSeconds(baseIso: string, seconds: number): string {
  return new Date(new Date(baseIso).getTime() + seconds * 1000).toISOString();
}
