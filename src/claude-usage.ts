import { spawn } from 'child_process';

import { logger } from './logger.js';

export interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

const CLAUDE_EXPECT_TIMEOUT_MS = 25000;
const ANSI_RE = /\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const EXPECT_PROGRAM = `
set timeout 20
log_user 1
match_max 200000
set binary $env(CLAUDE_BINARY)
spawn -noecho -- $binary --setting-sources user --allowed-tools ""
expect {
  -re "Do you trust the files in this folder\\\\?" { send "y\\r"; exp_continue }
  -re "Quick safety check:" { send "\\r"; exp_continue }
  -re "Yes, I trust this folder" { send "\\r"; exp_continue }
  -re "Ready to code here\\\\?" { send "\\r"; exp_continue }
  -re "Press Enter to continue" { send "\\r"; exp_continue }
  timeout {}
}
send "/usage\\r"
set deadline [expr {[clock seconds] + 20}]
while {[clock seconds] < $deadline} {
  expect {
    -re "Do you trust the files in this folder\\\\?" { send "y\\r"; exp_continue }
    -re "Quick safety check:" { send "\\r"; exp_continue }
    -re "Yes, I trust this folder" { send "\\r"; exp_continue }
    -re "Ready to code here\\\\?" { send "\\r"; exp_continue }
    -re "Press Enter to continue" { send "\\r"; exp_continue }
    -re "Current session" { after 2000; exit 0 }
    -re "Failed to load usage data" { after 500; exit 2 }
    eof { exit 3 }
    timeout { send "\\r" }
  }
}
exit 4
`;

function normalizeLines(rawText: string): string[] {
  return rawText
    .replace(ANSI_RE, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function parsePercent(windowText: string): number | null {
  const match = windowText.match(/(\d{1,3})%\s*(used|left)\b/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (Number.isNaN(value)) return null;
  return match[2].toLowerCase() === 'left' ? 100 - value : value;
}

function parseWindow(
  lines: string[],
  labels: string[],
): { utilization: number; resets_at: string } | null {
  const normalizedLabels = labels.map((label) => label.toLowerCase());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (!normalizedLabels.some((label) => line.includes(label))) continue;

    const windowLines = lines.slice(i, i + 6);
    const windowText = windowLines.join('\n');
    const utilization = parsePercent(windowText);
    if (utilization === null) continue;

    const resetLine = windowLines.find((candidate) =>
      candidate.toLowerCase().startsWith('resets'),
    );

    return {
      utilization,
      resets_at: resetLine || '',
    };
  }

  return null;
}

export function parseClaudeUsagePanel(rawText: string): ClaudeUsageData | null {
  const lines = normalizeLines(rawText);
  if (lines.length === 0) return null;
  if (
    lines.some((line) =>
      line.toLowerCase().includes('failed to load usage data'),
    )
  ) {
    return null;
  }

  const fiveHour = parseWindow(lines, ['Current session']);
  if (!fiveHour) return null;

  const sevenDay =
    parseWindow(lines, ['Current week (all models)']) ||
    parseWindow(lines, [
      'Current week (Sonnet only)',
      'Current week (Sonnet)',
    ]) ||
    parseWindow(lines, ['Current week (Opus)']);

  return {
    five_hour: fiveHour,
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  };
}

export async function fetchClaudeUsageViaCli(
  binary = 'claude',
): Promise<ClaudeUsageData | null> {
  return new Promise((resolve) => {
    let output = '';
    let finished = false;

    const finish = (value: ClaudeUsageData | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(value);
    };

    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn('expect', ['-c', EXPECT_PROGRAM], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...(process.env as Record<string, string>),
          CLAUDE_BINARY: binary,
        },
      });
    } catch (err) {
      logger.debug({ err }, 'Claude CLI PTY probe unavailable');
      finish(null);
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc?.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish(null);
    }, CLAUDE_EXPECT_TIMEOUT_MS);

    if (!proc.stdout || !proc.stderr) {
      finish(null);
      return;
    }

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    proc.stderr.on('data', (chunk: string) => {
      output += chunk;
    });
    proc.on('error', (err) => {
      logger.debug({ err }, 'Claude CLI PTY probe failed to start');
      finish(null);
    });
    proc.on('close', () => {
      const parsed = parseClaudeUsagePanel(output);
      if (!parsed && output.trim()) {
        logger.debug(
          { tail: output.slice(-400) },
          'Claude CLI PTY probe produced unparsable output',
        );
      }
      finish(parsed);
    });
  });
}
