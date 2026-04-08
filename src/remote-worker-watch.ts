import {
  REMOTE_WORKER_CONTROL_PLANE_HOST,
  REMOTE_WORKER_CONTROL_PLANE_PORT,
  REMOTE_WORKER_CONTROL_PLANE_TOKEN,
} from './config.js';
import { extractWatchCiTarget } from './task-watch-status.js';
import type { ScheduledTask } from './types.js';
import { fetchWithTimeout } from './utils.js';

export interface RemoteWorkerWatchMetadata {
  job_id: string;
  poll_count?: number;
  consecutive_errors?: number;
  last_checked_at?: string;
}

interface RemoteWorkerPublishInfo {
  branch_name?: string;
  commit_sha?: string;
  checks_url?: string;
  pull_request?: {
    number?: number;
    url?: string;
  };
}

interface RemoteWorkerJobStatusResponse {
  job?: {
    job_id?: string;
    status?: string;
    assigned_worker_id?: string | null;
    result_summary?: string | null;
    result_json?: Record<string, unknown> | null;
  };
  latest_attempt?: {
    worker_id?: string;
    status?: string;
    failure_code?: string | null;
    failure_message?: string | null;
    result_summary?: string | null;
    result_json?: Record<string, unknown> | null;
  } | null;
}

export interface RemoteWorkerJobCheckResult {
  terminal: boolean;
  resultSummary: string;
  completionMessage?: string;
}

export const MAX_REMOTE_WORKER_CONSECUTIVE_ERRORS = 5;

const REMOTE_WORKER_TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'cancelled',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePublishInfo(value: unknown): RemoteWorkerPublishInfo | null {
  if (!isRecord(value)) return null;
  const publish = value.publish;
  if (!isRecord(publish)) return null;

  const pullRequest = isRecord(publish.pull_request)
    ? {
        number:
          typeof publish.pull_request.number === 'number'
            ? publish.pull_request.number
            : undefined,
        url:
          typeof publish.pull_request.url === 'string'
            ? publish.pull_request.url
            : undefined,
      }
    : undefined;

  return {
    branch_name:
      typeof publish.branch_name === 'string' ? publish.branch_name : undefined,
    commit_sha:
      typeof publish.commit_sha === 'string' ? publish.commit_sha : undefined,
    checks_url:
      typeof publish.checks_url === 'string' ? publish.checks_url : undefined,
    pull_request: pullRequest,
  };
}

function getPublishInfo(
  payload: RemoteWorkerJobStatusResponse,
): RemoteWorkerPublishInfo | null {
  return (
    parsePublishInfo(payload.job?.result_json) ??
    parsePublishInfo(payload.latest_attempt?.result_json) ??
    null
  );
}

function formatRemoteWorkerConclusionLabel(status: string): string {
  switch (status) {
    case 'completed':
      return '성공';
    case 'failed':
      return '실패';
    case 'cancelled':
      return '취소됨';
    default:
      return status || '완료';
  }
}

export function parseRemoteWorkerWatchMetadata(
  raw: string | null | undefined,
): RemoteWorkerWatchMetadata | null {
  if (!raw) return null;

  let parsed: Partial<RemoteWorkerWatchMetadata>;
  try {
    parsed = JSON.parse(raw) as Partial<RemoteWorkerWatchMetadata>;
  } catch {
    return null;
  }

  if (typeof parsed.job_id !== 'string' || parsed.job_id.trim() === '') {
    return null;
  }

  return {
    job_id: parsed.job_id,
    poll_count:
      Number.isInteger(parsed.poll_count) && parsed.poll_count! >= 0
        ? parsed.poll_count
        : undefined,
    consecutive_errors:
      Number.isInteger(parsed.consecutive_errors) &&
      parsed.consecutive_errors! >= 0
        ? parsed.consecutive_errors
        : undefined,
    last_checked_at:
      typeof parsed.last_checked_at === 'string' &&
      parsed.last_checked_at.trim() !== ''
        ? parsed.last_checked_at
        : undefined,
  };
}

export function serializeRemoteWorkerWatchMetadata(
  metadata: RemoteWorkerWatchMetadata,
): string {
  return JSON.stringify(metadata);
}

export function computeRemoteWorkerWatcherDelayMs(
  task: Pick<ScheduledTask, 'schedule_value'>,
): number {
  const baseDelayMs = Number.parseInt(task.schedule_value, 10);
  return Number.isFinite(baseDelayMs) && baseDelayMs > 0 ? baseDelayMs : 15_000;
}

export async function checkRemoteWorkerJob(
  task: Pick<ScheduledTask, 'prompt' | 'ci_metadata'>,
): Promise<RemoteWorkerJobCheckResult> {
  const metadata = parseRemoteWorkerWatchMetadata(task.ci_metadata);
  if (!metadata) {
    throw new Error('Task is missing valid remote worker watch metadata');
  }

  if (!REMOTE_WORKER_CONTROL_PLANE_TOKEN) {
    throw new Error(
      'REMOTE_WORKER_CONTROL_PLANE_TOKEN is required for remote worker watchers',
    );
  }

  const response = await fetchWithTimeout(
    `http://${REMOTE_WORKER_CONTROL_PLANE_HOST}:${REMOTE_WORKER_CONTROL_PLANE_PORT}/v1/jobs/${encodeURIComponent(
      metadata.job_id,
    )}`,
    {
      headers: {
        Authorization: `Bearer ${REMOTE_WORKER_CONTROL_PLANE_TOKEN}`,
      },
    },
    10_000,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `remote worker api failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`,
    );
  }

  const payload = (await response.json()) as RemoteWorkerJobStatusResponse;
  const status = payload.job?.status || 'unknown';

  if (!REMOTE_WORKER_TERMINAL_STATUSES.has(status)) {
    return {
      terminal: false,
      resultSummary: `Remote worker job ${metadata.job_id} is ${status}`,
    };
  }

  const target =
    extractWatchCiTarget(task.prompt) || `Remote worker job ${metadata.job_id}`;
  const conclusionLabel = formatRemoteWorkerConclusionLabel(status);
  const publish = getPublishInfo(payload);
  const summary =
    payload.job?.result_summary ||
    payload.latest_attempt?.result_summary ||
    null;
  const workerId =
    payload.latest_attempt?.worker_id ||
    payload.job?.assigned_worker_id ||
    null;

  const lines = [
    `원격 작업 완료: ${target}`,
    `판정: ${conclusionLabel}`,
    `- 상태: ${status}`,
  ];

  if (workerId) {
    lines.push(`- 워커: ${workerId}`);
  }

  if (payload.latest_attempt?.failure_code) {
    lines.push(`- 실패 코드: ${payload.latest_attempt.failure_code}`);
  }

  if (summary) {
    lines.push(`- 요약: ${summary}`);
  }

  if (publish?.branch_name) {
    lines.push(`- 브랜치: ${publish.branch_name}`);
  }
  if (publish?.commit_sha) {
    lines.push(`- 커밋: ${publish.commit_sha}`);
  }
  if (publish?.pull_request?.url) {
    lines.push(`- PR: ${publish.pull_request.url}`);
  } else if (publish?.checks_url) {
    lines.push(`- 링크: ${publish.checks_url}`);
  }

  return {
    terminal: true,
    resultSummary: `${conclusionLabel}: remote worker job ${metadata.job_id}`,
    completionMessage: lines.join('\n'),
  };
}
