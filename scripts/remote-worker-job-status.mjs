#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_INTERVAL_SECONDS = 5;

function printUsage() {
  console.error(
    [
      'Usage:',
      '  node scripts/remote-worker-job-status.mjs <job-id> [--wait] [--interval <seconds>] [--json]',
      '',
      'Examples:',
      '  node scripts/remote-worker-job-status.mjs job_123',
      '  node scripts/remote-worker-job-status.mjs job_123 --wait',
      '  npm run job:status -- job_123 --wait',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  let jobId = null;
  let wait = false;
  let json = false;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--wait') {
      wait = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--interval') {
      const value = args[i + 1];
      if (!value) {
        throw new Error('--interval requires a number of seconds.');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--interval must be a positive number.');
      }
      intervalSeconds = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (jobId) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    jobId = arg;
  }

  if (!jobId) {
    throw new Error('A job ID is required.');
  }

  return { jobId, wait, json, intervalSeconds };
}

function readDotEnv(repoRoot) {
  const envPath = path.join(repoRoot, '.env');
  if (!fs.existsSync(envPath)) {
    return {};
  }

  const parsed = {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const index = line.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }

  return parsed;
}

function resolveConfig(repoRoot) {
  const fileEnv = readDotEnv(repoRoot);
  const token =
    process.env.REMOTE_WORKER_CONTROL_PLANE_TOKEN ||
    fileEnv.REMOTE_WORKER_CONTROL_PLANE_TOKEN;
  if (!token) {
    throw new Error(
      'REMOTE_WORKER_CONTROL_PLANE_TOKEN is missing in the environment or .env file.',
    );
  }

  const explicitBaseUrl =
    process.env.REMOTE_WORKER_CONTROL_PLANE_BASE_URL ||
    fileEnv.REMOTE_WORKER_CONTROL_PLANE_BASE_URL;
  if (explicitBaseUrl) {
    return { baseUrl: explicitBaseUrl.replace(/\/+$/u, ''), token };
  }

  const host =
    process.env.REMOTE_WORKER_CONTROL_PLANE_HOST ||
    fileEnv.REMOTE_WORKER_CONTROL_PLANE_HOST ||
    '127.0.0.1';
  const port =
    process.env.REMOTE_WORKER_CONTROL_PLANE_PORT ||
    fileEnv.REMOTE_WORKER_CONTROL_PLANE_PORT ||
    '8787';

  return { baseUrl: `http://${host}:${port}`, token };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJob(baseUrl, token, jobId) {
  const response = await fetch(`${baseUrl}/v1/jobs/${jobId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed (${response.status}): ${body}`);
  }

  return response.json();
}

function buildSummary(payload) {
  const job = payload.job ?? {};
  const attempt = payload.latest_attempt ?? {};
  const publish = job.result_json?.publish ?? attempt.result_json?.publish ?? null;

  return {
    jobId: job.job_id ?? '',
    status: job.status ?? '',
    attemptStatus: attempt.status ?? '',
    workerId: job.assigned_worker_id ?? attempt.worker_id ?? '',
    baseCommit: job.base_commit ?? '',
    branchName: publish?.branch_name ?? '',
    commitSha: publish?.commit_sha ?? '',
    prUrl: publish?.pull_request?.url ?? '',
    checksUrl: publish?.checks_url ?? '',
    summary: job.result_summary ?? attempt.result_summary ?? '',
    finishedAt: job.finished_at ?? attempt.finished_at ?? '',
  };
}

function printSummary(summary) {
  const lines = [
    `job=${summary.jobId}`,
    `status=${summary.status}`,
    `attempt=${summary.attemptStatus || 'none'}`,
    `worker=${summary.workerId || '-'}`,
    `base_commit=${summary.baseCommit || '-'}`,
    `branch=${summary.branchName || '-'}`,
    `commit=${summary.commitSha || '-'}`,
    `pr=${summary.prUrl || '-'}`,
    `checks=${summary.checksUrl || '-'}`,
    `finished_at=${summary.finishedAt || '-'}`,
  ];

  if (summary.summary) {
    lines.push(`summary=${summary.summary}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  try {
    const { jobId, wait, json, intervalSeconds } = parseArgs(process.argv);
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
    const { baseUrl, token } = resolveConfig(repoRoot);

    let payload = await fetchJob(baseUrl, token, jobId);
    let summary = buildSummary(payload);

    if (wait) {
      while (!TERMINAL_STATUSES.has(summary.status)) {
        process.stderr.write(
          `waiting: job=${summary.jobId} status=${summary.status} attempt=${summary.attemptStatus || 'none'} worker=${summary.workerId || '-'}\n`,
        );
        await sleep(intervalSeconds * 1000);
        payload = await fetchJob(baseUrl, token, jobId);
        summary = buildSummary(payload);
      }
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({ summary, payload }, null, 2)}\n`);
      return;
    }

    printSummary(summary);
  } catch (error) {
    printUsage();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
