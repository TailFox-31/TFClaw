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

const MUTATING_SHELL_PATTERNS = [
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
  /(^|[;&|])\s*(cat|echo|printf)\b[^#\n]*>>?/i,
];

export function isReviewerRuntime(
  roomRoleContext?: RoomRoleContext,
): boolean {
  return roomRoleContext?.role === 'reviewer';
}

function findGitSubcommand(args: string[]): string {
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    switch (arg) {
      case '-c':
      case '-C':
      case '--git-dir':
      case '--work-tree':
      case '--namespace':
      case '--exec-path':
      case '--config-env':
        skipNext = true;
        continue;
      default:
        break;
    }
    if (
      arg.startsWith('-c') ||
      arg.startsWith('-C') ||
      arg.startsWith('--git-dir=') ||
      arg.startsWith('--work-tree=') ||
      arg.startsWith('--namespace=') ||
      arg.startsWith('--exec-path=') ||
      arg.startsWith('--config-env=')
    ) {
      continue;
    }
    if (arg.startsWith('-')) {
      continue;
    }
    return arg;
  }
  return '';
}

function tokenizeShellWords(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of segment) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }

  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function isBlockedGitCommand(command: string): boolean {
  const segments = command
    .split(/&&|\|\||[;\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  for (const segment of segments) {
    const tokens = tokenizeShellWords(segment);
    if (tokens[0] !== 'git') {
      continue;
    }
    const subcommand = findGitSubcommand(tokens.slice(1));
    if (BLOCKED_GIT_SUBCOMMANDS.has(subcommand)) {
      return true;
    }
  }
  return false;
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

export function isReviewerMutatingShellCommand(command: string): boolean {
  const normalized = command.trim();
  return (
    isBlockedGitCommand(normalized) ||
    MUTATING_SHELL_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}
