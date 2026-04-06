import { z } from 'zod';

import {
  cancelRemoteWorkerAttempt,
  claimRemoteWorkerJob,
  completeRemoteWorkerAttempt,
  createRemoteWorkerJob,
  getRemoteWorkerJobStatus,
  heartbeatRemoteWorker,
  heartbeatRemoteWorkerAttempt,
  registerRemoteWorker,
  RemoteWorkerError,
  requestRemoteWorkerJobCancel,
  setRemoteWorkerDrain,
  startRemoteWorkerAttempt,
  uploadRemoteWorkerArtifact,
  failRemoteWorkerAttempt,
} from './remote-worker-db.js';

const idSchema = z.string().regex(/^[A-Za-z0-9:_-]{1,128}$/);
const capabilitySchema = z.string().regex(/^[a-z0-9]+:[a-z0-9._-]+$/);
const metadataSchema = z.record(z.string(), z.unknown());

const workerRegisterSchema = z.object({
  worker_id: idSchema,
  display_name: z.string().min(1).max(128),
  capability_tokens: z.array(capabilitySchema).min(1),
  max_concurrency: z.number().int().min(1).max(32),
  version: z.string().optional(),
  metadata: metadataSchema.optional(),
});

const workerHeartbeatSchema = z.object({
  status: z.enum(['idle', 'busy', 'offline', 'draining']),
  running_attempt_ids: z.array(idSchema),
  metadata: metadataSchema.optional(),
});

const workerDrainSchema = z.object({
  enabled: z.boolean(),
});

const jobCreateSchema = z
  .object({
    workspace_key: idSchema,
    session_key: idSchema.optional(),
    session_policy: z.enum(['fresh', 'prefer_reuse', 'require_reuse']),
    repo_url: z.string().min(1).max(2048),
    branch: z.string().min(1).max(256),
    base_commit: z.string().regex(/^[a-f0-9]{7,64}$/),
    mode: z.enum(['edit', 'review', 'build', 'test', 'unity_batch']),
    requirements: z.array(capabilitySchema),
    prompt: z.string().min(1).max(200000),
    target_files: z.array(z.string().min(1)).optional(),
    artifact_policy: z.record(z.string(), z.string()).optional(),
    timeout_sec: z.number().int().min(30).max(86400),
    priority: z.number().int().min(0).max(100000),
    max_attempts: z.number().int().min(1).max(20),
  })
  .superRefine((value, ctx) => {
    if (
      (value.session_policy === 'prefer_reuse' ||
        value.session_policy === 'require_reuse') &&
      !value.session_key
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'session_key is required for reuse policies.',
        path: ['session_key'],
      });
    }
  });

const jobClaimSchema = z.object({
  worker_id: idSchema,
});

const attemptStartSchema = z.object({
  worker_id: idSchema,
  provider: z.enum(['codex', 'claude-code']),
  opaque_session_id: z.string().min(1),
  session_reused: z.boolean(),
});

const attemptHeartbeatSchema = z.object({
  worker_id: idSchema,
  progress_phase: z.string().max(128).optional(),
  progress_message: z.string().max(2000).optional(),
  session_touch: z.boolean().optional(),
});

const attemptCompleteSchema = z.object({
  worker_id: idSchema,
  result_summary: z.string().min(1).max(4000),
  result_json: metadataSchema.optional(),
});

const attemptFailSchema = z.object({
  worker_id: idSchema,
  failure_code: z.string().min(1).max(128),
  failure_message: z.string().min(1).max(4000),
  retryable: z.boolean(),
  result_json: metadataSchema.optional(),
});

const attemptCancelledSchema = z.object({
  worker_id: idSchema,
  result_summary: z.string().max(4000).optional(),
  result_json: metadataSchema.optional(),
});

const artifactUploadSchema = z.union([
  z.object({
    kind: z.enum([
      'stdout',
      'stderr',
      'patch',
      'diff',
      'screenshot',
      'build_output',
      'report',
      'archive',
    ]),
    storage_type: z.literal('inline'),
    content_base64: z.string().min(1),
    content_type: z.string().min(1),
    sha256: z.string().optional(),
    size_bytes: z.number().int().min(0).optional(),
    metadata: metadataSchema.optional(),
  }),
  z.object({
    kind: z.enum([
      'stdout',
      'stderr',
      'patch',
      'diff',
      'screenshot',
      'build_output',
      'report',
      'archive',
    ]),
    storage_type: z.literal('remote_url'),
    locator_url: z.string().url(),
    content_type: z.string().min(1),
    sha256: z.string().optional(),
    size_bytes: z.number().int().min(0).optional(),
    metadata: metadataSchema.optional(),
  }),
]);

const jobCancelSchema = z.object({
  reason: z.string().min(1).max(1000),
});

interface RemoteWorkerApiOptions {
  bearerToken?: string;
}

export function createRemoteWorkerApiHandler(
  options: RemoteWorkerApiOptions = {},
) {
  return async (request: Request): Promise<Response> => {
    try {
      requireBearerAuth(request, options.bearerToken);

      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      if (method === 'POST' && path === '/v1/workers/register') {
        const body = await parseJson(request, workerRegisterSchema);
        return json(registerRemoteWorker(body));
      }

      const workerHeartbeatMatch = path.match(
        /^\/v1\/workers\/([^/]+)\/heartbeat$/,
      );
      if (method === 'POST' && workerHeartbeatMatch) {
        const workerId = decodeURIComponent(workerHeartbeatMatch[1]);
        const body = await parseJson(request, workerHeartbeatSchema);
        return json(heartbeatRemoteWorker(workerId, body));
      }

      const workerDrainMatch = path.match(/^\/v1\/workers\/([^/]+)\/drain$/);
      if (method === 'POST' && workerDrainMatch) {
        const workerId = decodeURIComponent(workerDrainMatch[1]);
        const body = await parseJson(request, workerDrainSchema);
        return json(setRemoteWorkerDrain(workerId, body.enabled));
      }

      if (method === 'POST' && path === '/v1/jobs') {
        const body = await parseJson(request, jobCreateSchema);
        return json(createRemoteWorkerJob(body), 201);
      }

      if (method === 'POST' && path === '/v1/jobs/claim') {
        const body = await parseJson(request, jobClaimSchema);
        const result = claimRemoteWorkerJob(body.worker_id);
        if (!result) {
          return new Response(null, { status: 204 });
        }
        return json(result);
      }

      const jobMatch = path.match(/^\/v1\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const jobId = decodeURIComponent(jobMatch[1]);
        return json(getRemoteWorkerJobStatus(jobId));
      }

      const jobCancelMatch = path.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (method === 'POST' && jobCancelMatch) {
        const jobId = decodeURIComponent(jobCancelMatch[1]);
        const body = await parseJson(request, jobCancelSchema);
        return json(requestRemoteWorkerJobCancel(jobId, body.reason));
      }

      const attemptStartMatch = path.match(/^\/v1\/attempts\/([^/]+)\/start$/);
      if (method === 'POST' && attemptStartMatch) {
        const attemptId = decodeURIComponent(attemptStartMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, attemptStartSchema);
        return json(startRemoteWorkerAttempt(attemptId, leaseToken, body));
      }

      const attemptHeartbeatMatch = path.match(
        /^\/v1\/attempts\/([^/]+)\/heartbeat$/,
      );
      if (method === 'POST' && attemptHeartbeatMatch) {
        const attemptId = decodeURIComponent(attemptHeartbeatMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, attemptHeartbeatSchema);
        return json(heartbeatRemoteWorkerAttempt(attemptId, leaseToken, body));
      }

      const attemptCompleteMatch = path.match(
        /^\/v1\/attempts\/([^/]+)\/complete$/,
      );
      if (method === 'POST' && attemptCompleteMatch) {
        const attemptId = decodeURIComponent(attemptCompleteMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, attemptCompleteSchema);
        return json(completeRemoteWorkerAttempt(attemptId, leaseToken, body));
      }

      const attemptFailMatch = path.match(/^\/v1\/attempts\/([^/]+)\/fail$/);
      if (method === 'POST' && attemptFailMatch) {
        const attemptId = decodeURIComponent(attemptFailMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, attemptFailSchema);
        return json(failRemoteWorkerAttempt(attemptId, leaseToken, body));
      }

      const attemptCancelledMatch = path.match(
        /^\/v1\/attempts\/([^/]+)\/cancelled$/,
      );
      if (method === 'POST' && attemptCancelledMatch) {
        const attemptId = decodeURIComponent(attemptCancelledMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, attemptCancelledSchema);
        return json(cancelRemoteWorkerAttempt(attemptId, leaseToken, body));
      }

      const artifactMatch = path.match(
        /^\/v1\/attempts\/([^/]+)\/artifacts$/,
      );
      if (method === 'POST' && artifactMatch) {
        const attemptId = decodeURIComponent(artifactMatch[1]);
        const leaseToken = requireLeaseToken(request);
        const body = await parseJson(request, artifactUploadSchema);
        return json(uploadRemoteWorkerArtifact(attemptId, leaseToken, body), 201);
      }

      return errorResponse(404, 'not_found', 'Route not found.');
    } catch (error) {
      return mapErrorToResponse(error);
    }
  };
}

async function parseJson<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new RemoteWorkerError(
      'validation_error',
      422,
      'Request body must be valid JSON.',
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new RemoteWorkerError(
      'validation_error',
      422,
      'Request validation failed.',
      { issues: z.treeifyError(result.error) },
    );
  }
  return result.data;
}

function requireBearerAuth(
  request: Request,
  expectedBearerToken?: string,
): void {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ') || authHeader.length <= 'Bearer '.length) {
    throw new RemoteWorkerError(
      'unauthorized',
      401,
      'Missing or invalid bearer token.',
    );
  }

  if (expectedBearerToken) {
    const token = authHeader.slice('Bearer '.length);
    if (token !== expectedBearerToken) {
      throw new RemoteWorkerError(
        'unauthorized',
        401,
        'Bearer token mismatch.',
      );
    }
  }
}

function requireLeaseToken(request: Request): string {
  const leaseToken = request.headers.get('X-Lease-Token');
  if (!leaseToken) {
    throw new RemoteWorkerError(
      'validation_error',
      422,
      'Missing X-Lease-Token header.',
    );
  }
  return leaseToken;
}

function mapErrorToResponse(error: unknown): Response {
  if (error instanceof RemoteWorkerError) {
    return errorResponse(error.status, error.code, error.message, error.details);
  }
  return errorResponse(500, 'internal_error', errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json(
    {
      error: {
        code,
        message,
        ...(details ? { details } : {}),
      },
    },
    status,
  );
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}
