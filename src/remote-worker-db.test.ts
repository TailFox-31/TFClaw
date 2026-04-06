import { describe, expect, it, beforeEach } from 'vitest';

import { _initTestDatabase, getDatabaseHandle } from './db.js';
import {
  claimRemoteWorkerJob,
  createRemoteWorkerJob,
  getRemoteWorkerJobStatus,
  heartbeatRemoteWorkerAttempt,
  registerRemoteWorker,
  requestRemoteWorkerJobCancel,
  startRemoteWorkerAttempt,
} from './remote-worker-db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('remote worker db', () => {
  it('requeues a job after lease timeout', () => {
    registerRemoteWorker({
      worker_id: 'worker-a',
      display_name: 'Worker A',
      capability_tokens: ['os:linux', 'tool:git'],
      max_concurrency: 1,
    });
    registerRemoteWorker({
      worker_id: 'worker-b',
      display_name: 'Worker B',
      capability_tokens: ['os:linux', 'tool:git'],
      max_concurrency: 1,
    });

    const created = createRemoteWorkerJob({
      workspace_key: 'repo:game-main',
      session_policy: 'fresh',
      repo_url: 'git@example.com:org/game.git',
      branch: 'main',
      base_commit: 'abc1234',
      mode: 'edit',
      requirements: ['tool:git', 'os:linux'],
      prompt: 'Update combat tuning',
      timeout_sec: 1800,
      priority: 100,
      max_attempts: 3,
    });
    const firstClaim = claimRemoteWorkerJob('worker-a');
    expect(firstClaim).not.toBeNull();

    const db = getDatabaseHandle();
    db.prepare(
      `UPDATE job_attempts
         SET last_heartbeat_at = ?
       WHERE attempt_id = ?`,
    ).run('2000-01-01T00:00:00.000Z', firstClaim!.attempt.attempt_id);

    const secondClaim = claimRemoteWorkerJob('worker-b');
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.job.job_id).toBe(created.job_id);
    expect(secondClaim!.attempt.attempt_id).not.toBe(firstClaim!.attempt.attempt_id);
    expect(secondClaim!.job.attempt_count).toBe(2);
  });

  it('forces cancellation after the interrupt deadline', () => {
    registerRemoteWorker({
      worker_id: 'worker-a',
      display_name: 'Worker A',
      capability_tokens: ['os:windows', 'tool:unity-editor'],
      max_concurrency: 1,
    });

    const created = createRemoteWorkerJob({
      workspace_key: 'repo:game-main',
      session_policy: 'fresh',
      repo_url: 'git@example.com:org/game.git',
      branch: 'main',
      base_commit: 'abc1234',
      mode: 'unity_batch',
      requirements: ['tool:unity-editor', 'os:windows'],
      prompt: 'Run scene validation',
      timeout_sec: 1800,
      priority: 100,
      max_attempts: 3,
    });
    const claim = claimRemoteWorkerJob('worker-a');
    expect(claim).not.toBeNull();

    startRemoteWorkerAttempt(claim!.attempt.attempt_id, claim!.attempt.lease_token, {
      worker_id: 'worker-a',
      provider: 'codex',
      opaque_session_id: 'sess-1',
      session_reused: false,
    });

    requestRemoteWorkerJobCancel(created.job_id, 'user requested cancel');

    const db = getDatabaseHandle();
    db.prepare(
      `UPDATE job_attempts
         SET interrupt_deadline_at = ?
       WHERE attempt_id = ?`,
    ).run('2000-01-01T00:00:00.000Z', claim!.attempt.attempt_id);

    const status = getRemoteWorkerJobStatus(created.job_id);
    expect(status.job.status).toBe('cancelled');
    expect(status.latest_attempt?.status).toBe('cancelled');
  });

  it('returns cancel_requested through attempt heartbeat', () => {
    registerRemoteWorker({
      worker_id: 'worker-a',
      display_name: 'Worker A',
      capability_tokens: ['os:linux', 'tool:git'],
      max_concurrency: 1,
    });
    const created = createRemoteWorkerJob({
      workspace_key: 'repo:game-main',
      session_policy: 'fresh',
      repo_url: 'git@example.com:org/game.git',
      branch: 'main',
      base_commit: 'abc1234',
      mode: 'edit',
      requirements: ['tool:git', 'os:linux'],
      prompt: 'Patch balance config',
      timeout_sec: 1800,
      priority: 100,
      max_attempts: 3,
    });
    const claim = claimRemoteWorkerJob('worker-a');
    expect(claim).not.toBeNull();

    startRemoteWorkerAttempt(claim!.attempt.attempt_id, claim!.attempt.lease_token, {
      worker_id: 'worker-a',
      provider: 'codex',
      opaque_session_id: 'sess-1',
      session_reused: false,
    });
    requestRemoteWorkerJobCancel(created.job_id, 'user requested cancel');

    const heartbeat = heartbeatRemoteWorkerAttempt(
      claim!.attempt.attempt_id,
      claim!.attempt.lease_token,
      { worker_id: 'worker-a' },
    );
    expect(heartbeat.cancel_requested).toBe(true);
    expect(heartbeat.cancel_reason).toBe('user requested cancel');
    expect(heartbeat.interrupt_deadline_at).toBeTruthy();
  });
});
