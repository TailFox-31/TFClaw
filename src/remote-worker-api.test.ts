import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { createRemoteWorkerApiHandler } from './remote-worker-api.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('remote worker api', () => {
  it('runs the basic register -> create -> claim -> start -> complete flow', async () => {
    const handler = createRemoteWorkerApiHandler();

    const registerRes = await send(handler, '/v1/workers/register', {
      method: 'POST',
      body: {
        worker_id: 'worker-a',
        display_name: 'Worker A',
        capability_tokens: ['os:windows', 'tool:unity-editor'],
        max_concurrency: 1,
      },
    });
    expect(registerRes.status).toBe(200);

    const createRes = await send(handler, '/v1/jobs', {
      method: 'POST',
      body: {
        workspace_key: 'repo:game-main',
        session_policy: 'fresh',
        repo_url: 'git@example.com:org/game.git',
        branch: 'main',
        base_commit: 'abc1234',
        mode: 'unity_batch',
        requirements: ['tool:unity-editor', 'os:windows'],
        prompt: 'Run a lightweight validation batch',
        timeout_sec: 1800,
        priority: 100,
        max_attempts: 3,
      },
    });
    expect(createRes.status).toBe(201);
    const created = await readJson<{ job_id: string }>(createRes);

    const claimRes = await send(handler, '/v1/jobs/claim', {
      method: 'POST',
      body: { worker_id: 'worker-a' },
    });
    expect(claimRes.status).toBe(200);
    const claimed = await readJson<{
      attempt: { attempt_id: string; lease_token: string };
    }>(claimRes);

    const startRes = await send(
      handler,
      `/v1/attempts/${claimed.attempt.attempt_id}/start`,
      {
        method: 'POST',
        leaseToken: claimed.attempt.lease_token,
        body: {
          worker_id: 'worker-a',
          provider: 'codex',
          opaque_session_id: 'sess-1',
          session_reused: false,
        },
      },
    );
    expect(startRes.status).toBe(200);

    const completeRes = await send(
      handler,
      `/v1/attempts/${claimed.attempt.attempt_id}/complete`,
      {
        method: 'POST',
        leaseToken: claimed.attempt.lease_token,
        body: {
          worker_id: 'worker-a',
          result_summary: 'validation finished',
          result_json: { ok: true },
        },
      },
    );
    expect(completeRes.status).toBe(200);

    const statusRes = await send(handler, `/v1/jobs/${created.job_id}`, {
      method: 'GET',
    });
    expect(statusRes.status).toBe(200);
    const status = await readJson<{
      job: { status: string };
      latest_attempt: { status: string };
    }>(statusRes);
    expect(status.job.status).toBe('completed');
    expect(status.latest_attempt.status).toBe('completed');
  });

  it('returns 204 when no matching job exists', async () => {
    const handler = createRemoteWorkerApiHandler();
    await send(handler, '/v1/workers/register', {
      method: 'POST',
      body: {
        worker_id: 'worker-a',
        display_name: 'Worker A',
        capability_tokens: ['os:linux', 'tool:git'],
        max_concurrency: 1,
      },
    });

    const claimRes = await send(handler, '/v1/jobs/claim', {
      method: 'POST',
      body: { worker_id: 'worker-a' },
    });
    expect(claimRes.status).toBe(204);
  });

  it('rejects reuse policies without session_key', async () => {
    const handler = createRemoteWorkerApiHandler();
    const res = await send(handler, '/v1/jobs', {
      method: 'POST',
      body: {
        workspace_key: 'repo:game-main',
        session_policy: 'require_reuse',
        repo_url: 'git@example.com:org/game.git',
        branch: 'main',
        base_commit: 'abc1234',
        mode: 'edit',
        requirements: ['tool:git', 'os:linux'],
        prompt: 'Do work',
        timeout_sec: 1800,
        priority: 100,
        max_attempts: 3,
      },
    });
    expect(res.status).toBe(422);
  });

  it('surfaces cancellation through attempt heartbeat', async () => {
    const handler = createRemoteWorkerApiHandler();
    await send(handler, '/v1/workers/register', {
      method: 'POST',
      body: {
        worker_id: 'worker-a',
        display_name: 'Worker A',
        capability_tokens: ['os:linux', 'tool:git'],
        max_concurrency: 1,
      },
    });
    const createRes = await send(handler, '/v1/jobs', {
      method: 'POST',
      body: {
        workspace_key: 'repo:game-main',
        session_policy: 'fresh',
        repo_url: 'git@example.com:org/game.git',
        branch: 'main',
        base_commit: 'abc1234',
        mode: 'edit',
        requirements: ['tool:git', 'os:linux'],
        prompt: 'Patch config',
        timeout_sec: 1800,
        priority: 100,
        max_attempts: 3,
      },
    });
    const created = await readJson<{ job_id: string }>(createRes);
    const claimRes = await send(handler, '/v1/jobs/claim', {
      method: 'POST',
      body: { worker_id: 'worker-a' },
    });
    const claimed = await readJson<{
      attempt: { attempt_id: string; lease_token: string };
    }>(claimRes);

    await send(handler, `/v1/attempts/${claimed.attempt.attempt_id}/start`, {
      method: 'POST',
      leaseToken: claimed.attempt.lease_token,
      body: {
        worker_id: 'worker-a',
        provider: 'codex',
        opaque_session_id: 'sess-1',
        session_reused: false,
      },
    });

    const cancelRes = await send(handler, `/v1/jobs/${created.job_id}/cancel`, {
      method: 'POST',
      body: { reason: 'user requested cancel' },
    });
    expect(cancelRes.status).toBe(200);

    const heartbeatRes = await send(
      handler,
      `/v1/attempts/${claimed.attempt.attempt_id}/heartbeat`,
      {
        method: 'POST',
        leaseToken: claimed.attempt.lease_token,
        body: { worker_id: 'worker-a' },
      },
    );
    expect(heartbeatRes.status).toBe(200);
    const heartbeat = await readJson<{
      cancel_requested: boolean;
      cancel_reason: string;
    }>(heartbeatRes);
    expect(heartbeat.cancel_requested).toBe(true);
    expect(heartbeat.cancel_reason).toBe('user requested cancel');
  });

  it('requires bearer auth', async () => {
    const handler = createRemoteWorkerApiHandler();
    const res = await handler(
      new Request('http://localhost/v1/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspace_key: 'repo:game-main',
          session_policy: 'fresh',
          repo_url: 'git@example.com:org/game.git',
          branch: 'main',
          base_commit: 'abc1234',
          mode: 'edit',
          requirements: ['tool:git', 'os:linux'],
          prompt: 'Do work',
          timeout_sec: 1800,
          priority: 100,
          max_attempts: 3,
        }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects mismatched configured bearer token', async () => {
    const handler = createRemoteWorkerApiHandler({ bearerToken: 'expected-token' });
    const res = await handler(
      new Request('http://localhost/v1/jobs/claim', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer wrong-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          worker_id: 'worker-a',
        }),
      }),
    );

    expect(res.status).toBe(401);
  });
});

async function send(
  handler: ReturnType<typeof createRemoteWorkerApiHandler>,
  path: string,
  input: {
    method: string;
    body?: unknown;
    leaseToken?: string;
  },
): Promise<Response> {
  const headers = new Headers({
    Authorization: 'Bearer test-token',
  });
  if (input.body !== undefined) {
    headers.set('content-type', 'application/json');
  }
  if (input.leaseToken) {
    headers.set('X-Lease-Token', input.leaseToken);
  }

  return handler(
    new Request(`http://localhost${path}`, {
      method: input.method,
      headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    }),
  );
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
