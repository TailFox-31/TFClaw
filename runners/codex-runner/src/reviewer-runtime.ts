import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { RoomRoleContext } from './room-role-context.js';

const BLOCKED_GIT_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'commit',
  'merge',
  'push',
  'rebase',
  'reset',
  'restore',
  'stash',
  'switch',
  'tag',
  'worktree',
]);

export function isReviewerRuntime(
  roomRoleContext?: RoomRoleContext,
): boolean {
  return roomRoleContext?.role === 'reviewer';
}

function resolveGitBinary(baseEnv: NodeJS.ProcessEnv): string {
  return execFileSync('bash', ['-lc', 'command -v git'], {
    encoding: 'utf-8',
    env: baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function buildReviewerGitGuardEnv(
  baseEnv: NodeJS.ProcessEnv,
  reviewerRuntime: boolean,
): NodeJS.ProcessEnv {
  if (!reviewerRuntime) {
    return baseEnv;
  }

  const realGitPath = resolveGitBinary(baseEnv);
  const wrapperDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ejclaw-reviewer-git-'),
  );
  const wrapperPath = path.join(wrapperDir, 'git');
  const blocked = [...BLOCKED_GIT_SUBCOMMANDS]
    .map((value) => `'${value}'`)
    .join(' ');

  const script = `#!/usr/bin/env bash
set -euo pipefail
real_git=${JSON.stringify(realGitPath)}
blocked_subcommands=(${blocked})
subcmd=""
skip_next=0
for arg in "$@"; do
  if [[ "$skip_next" == "1" ]]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -c|-C|--git-dir|--work-tree|--namespace|--exec-path|--config-env)
      skip_next=1
      continue
      ;;
    -c*|-C*|--git-dir=*|--work-tree=*|--namespace=*|--exec-path=*|--config-env=*)
      continue
      ;;
    --*)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      subcmd="$arg"
      break
      ;;
  esac
done
for blocked in "\${blocked_subcommands[@]}"; do
  if [[ "$subcmd" == "$blocked" ]]; then
    echo "EJClaw reviewer runtime blocks mutating git subcommands: $subcmd" >&2
    exit 1
  fi
done
exec "$real_git" "$@"
`;

  fs.writeFileSync(wrapperPath, script, { mode: 0o755 });
  return {
    ...baseEnv,
    EJCLAW_REAL_GIT: realGitPath,
    PATH: `${wrapperDir}:${baseEnv.PATH || ''}`,
  };
}
