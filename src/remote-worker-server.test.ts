import type { AddressInfo } from 'net';
import type { Server } from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './db.js';
import { startRemoteWorkerControlPlane } from './remote-worker-server.js';

const servers: Server[] = [];

beforeEach(() => {
  _initTestDatabase();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0, servers.length).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
    ),
  );
});

describe('remote worker control plane server', () => {
  it('binds an HTTP server that serves the remote worker API', async () => {
    const server = await startRemoteWorkerControlPlane(0, '127.0.0.1', 'server-token');
    servers.push(server);

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/workers/register`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer server-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        worker_id: 'worker-a',
        display_name: 'Worker A',
        capability_tokens: ['tool:git', 'os:linux'],
        max_concurrency: 1,
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      worker_id: 'worker-a',
    });
  });

  it('rejects requests with the wrong bearer token', async () => {
    const server = await startRemoteWorkerControlPlane(0, '127.0.0.1', 'server-token');
    servers.push(server);

    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/workers/register`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        worker_id: 'worker-a',
        display_name: 'Worker A',
        capability_tokens: ['tool:git', 'os:linux'],
        max_concurrency: 1,
      }),
    });

    expect(response.status).toBe(401);
  });
});
