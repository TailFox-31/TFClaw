import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.stubGlobal('fetch', fetchMock);

describe('remote-worker-watch helpers', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      REMOTE_WORKER_CONTROL_PLANE_HOST: '127.0.0.1',
      REMOTE_WORKER_CONTROL_PLANE_PORT: '8787',
      REMOTE_WORKER_CONTROL_PLANE_TOKEN: 'test-token',
    };
    fetchMock.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadModule() {
    vi.resetModules();
    return import('./remote-worker-watch.js');
  }

  it('round-trips remote worker watch metadata', async () => {
    const {
      parseRemoteWorkerWatchMetadata,
      serializeRemoteWorkerWatchMetadata,
    } = await loadModule();

    const raw = serializeRemoteWorkerWatchMetadata({
      job_id: 'job_abc',
      poll_count: 1,
    });

    expect(parseRemoteWorkerWatchMetadata(raw)).toEqual({
      job_id: 'job_abc',
      poll_count: 1,
      consecutive_errors: undefined,
      last_checked_at: undefined,
    });
    expect(parseRemoteWorkerWatchMetadata('{"job_id":""}')).toBeNull();
  });

  it('returns non-terminal status for running jobs', async () => {
    const { checkRemoteWorkerJob } = await loadModule();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          job: { status: 'running' },
        }),
        { status: 200 },
      ),
    );

    await expect(
      checkRemoteWorkerJob({
        prompt: `
[BACKGROUND CI WATCH]

Watch target:
Remote worker job job_abc

Check instructions:
Managed by host-driven watcher.
        `.trim(),
        ci_metadata: JSON.stringify({
          job_id: 'job_abc',
        }),
      }),
    ).resolves.toEqual({
      terminal: false,
      resultSummary: 'Remote worker job job_abc is running',
    });
  });

  it('renders a concise completion message for terminal jobs with PR info', async () => {
    const { checkRemoteWorkerJob } = await loadModule();
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          job: {
            status: 'completed',
            assigned_worker_id: 'worker-win-01',
            result_summary: 'prototype applied',
            result_json: {
              publish: {
                branch_name: 'job/job_123',
                commit_sha: 'abcdef123456',
                pull_request: {
                  url: 'https://github.com/TailFox-31/idle-game/pull/99',
                },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await checkRemoteWorkerJob({
      prompt: `
[BACKGROUND CI WATCH]

Watch target:
Remote worker job job_abc

Check instructions:
Managed by host-driven watcher.
      `.trim(),
      ci_metadata: JSON.stringify({
        job_id: 'job_abc',
      }),
    });

    expect(result.terminal).toBe(true);
    expect(result.resultSummary).toContain('성공');
    expect(result.completionMessage).toContain(
      '원격 작업 완료: Remote worker job job_abc',
    );
    expect(result.completionMessage).toContain('- 워커: worker-win-01');
    expect(result.completionMessage).toContain(
      '- PR: https://github.com/TailFox-31/idle-game/pull/99',
    );
  });
});
