import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { createRemoteWorkerApiHandler } from './remote-worker-api.js';
import { logger } from './logger.js';

export function startRemoteWorkerControlPlane(
  port: number,
  host: string,
  bearerToken: string,
): Promise<Server> {
  const handler = createRemoteWorkerApiHandler({ bearerToken });

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleNodeRequest(req, res, handler).catch((error) => {
        logger.error({ err: error }, 'Remote worker control plane request failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Internal Server Error');
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Remote worker control plane started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

async function handleNodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
): Promise<void> {
  const body = await readBody(req);
  const request = new Request(buildRequestUrl(req), {
    method: req.method || 'GET',
    headers: toHeaders(req),
    body:
      body.length > 0 && req.method !== 'GET' && req.method !== 'HEAD'
        ? body
        : undefined,
  });

  const response = await handler(request);

  res.statusCode = response.status;
  for (const [name, value] of response.headers.entries()) {
    res.setHeader(name, value);
  }

  const responseBody = await response.arrayBuffer();
  res.end(Buffer.from(responseBody));
}

function buildRequestUrl(req: IncomingMessage): string {
  const hostHeader = req.headers.host || '127.0.0.1';
  const path = req.url || '/';
  return `http://${hostHeader}${path}`;
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();

  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
      continue;
    }

    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  return headers;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
