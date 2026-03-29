/**
 * Credential proxy for reviewer container isolation.
 * Containers connect here instead of directly to AI APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Supports both Claude (Anthropic) and Codex (OpenAI) APIs:
 *   Claude API key:  Proxy injects x-api-key on every request.
 *   Claude OAuth:    Proxy replaces placeholder Bearer token with real one.
 *   Codex:           Proxy injects Authorization: Bearer {OPENAI_API_KEY}.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { getEnv } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const anthropicApiKey = getEnv('ANTHROPIC_API_KEY') || '';
  const oauthToken =
    getEnv('CLAUDE_CODE_OAUTH_TOKEN') || getEnv('ANTHROPIC_AUTH_TOKEN') || '';
  const anthropicBaseUrl =
    getEnv('ANTHROPIC_BASE_URL') || 'https://api.anthropic.com';
  const openaiApiKey = getEnv('OPENAI_API_KEY') || '';

  const authMode: AuthMode = anthropicApiKey ? 'api-key' : 'oauth';

  const anthropicUrl = new URL(anthropicBaseUrl);
  const anthropicIsHttps = anthropicUrl.protocol === 'https:';
  const makeAnthropicRequest = anthropicIsHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Route: Codex/OpenAI requests go to OpenAI API
        const isOpenAI =
          req.headers['x-ejclaw-provider'] === 'openai' ||
          (req.url || '').startsWith('/v1/chat/completions');

        if (isOpenAI) {
          proxyToOpenAI(req, res, body, openaiApiKey);
          return;
        }

        // Default: Anthropic/Claude API
        const headers: Record<
          string,
          string | number | string[] | undefined
        > = {
          ...(req.headers as Record<string, string>),
          host: anthropicUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];
        delete headers['x-ejclaw-provider'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = anthropicApiKey;
        } else if (headers['authorization']) {
          delete headers['authorization'];
          if (oauthToken) {
            headers['authorization'] = `Bearer ${oauthToken}`;
          }
        }

        const upstream = makeAnthropicRequest(
          {
            hostname: anthropicUrl.hostname,
            port: anthropicUrl.port || (anthropicIsHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error (Anthropic)',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

function proxyToOpenAI(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  body: Buffer,
  apiKey: string,
): void {
  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: 'api.openai.com',
    'content-length': body.length,
  };

  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  delete headers['x-ejclaw-provider'];

  // Inject real OpenAI API key
  delete headers['authorization'];
  if (apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const upstream = httpsRequest(
    {
      hostname: 'api.openai.com',
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error(
      { err, url: req.url },
      'Credential proxy upstream error (OpenAI)',
    );
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

export function detectAuthMode(): AuthMode {
  return getEnv('ANTHROPIC_API_KEY') ? 'api-key' : 'oauth';
}
