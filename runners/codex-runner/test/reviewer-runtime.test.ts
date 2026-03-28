import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  buildReviewerGitGuardEnv,
  isReviewerRuntime,
} from '../src/reviewer-runtime.js';

describe('codex reviewer runtime guard', () => {
  it('detects reviewer room metadata', () => {
    expect(
      isReviewerRuntime({
        serviceId: 'codex-review',
        role: 'reviewer',
        ownerServiceId: 'codex-main',
        reviewerServiceId: 'codex-review',
        failoverOwner: false,
      }),
    ).toBe(true);
  });

  it('prepends a git wrapper to PATH for reviewer runtimes', () => {
    const env = buildReviewerGitGuardEnv({ PATH: process.env.PATH }, true);
    expect(env.PATH).toContain('ejclaw-reviewer-git-');
    expect(env.EJCLAW_REAL_GIT).toBeTruthy();
  });

  it('blocks mutating git subcommands even when git options come first', () => {
    const env = buildReviewerGitGuardEnv({ PATH: process.env.PATH }, true);
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-reviewer-test-'));

    try {
      execFileSync('git', ['-c', 'color.ui=false', 'commit', '-m', 'x'], {
        cwd,
        env,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('expected git wrapper to block commit');
    } catch (error) {
      const stderr =
        error instanceof Error && 'stderr' in error
          ? String((error as Error & { stderr?: string | Buffer }).stderr ?? '')
          : '';
      expect(stderr).toContain(
        'EJClaw reviewer runtime blocks mutating git subcommands: commit',
      );
    }
  });
});
