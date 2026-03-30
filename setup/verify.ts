/**
 * Step: verify — End-to-end health check of the full installation.
 * Replaces 09-verify.sh
 *
 * Supports the EJClaw service stack:
 *   - ejclaw (Claude Code) — always checked
 *   - ejclaw-codex (Codex) — checked when .env.codex exists
 *   - ejclaw-review (Codex Review) — checked when .env.codex-review exists
 *
 * Uses better-sqlite3 directly (no sqlite3 CLI), platform-aware service checks.
 */
import { logger } from '../src/logger.js';
import { getServiceManager } from './platform.js';
import { getServiceDefs } from './service-defs.js';
import { emitStatus } from './status.js';
import {
  buildVerifySummary,
  detectChannelAuth,
  detectCredentials,
  loadRegisteredGroupsSummary,
} from './verify-state.js';
import { getServiceChecks } from './verify-services.js';

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const mgr = getServiceManager();

  logger.info('Starting verification');

  // 1. Check service statuses
  const serviceDefs = getServiceDefs(projectRoot);
  const services = getServiceChecks(serviceDefs, projectRoot, mgr);

  for (const svc of services) {
    logger.info({ service: svc.name, status: svc.status }, 'Service status');
  }

  const credentials = detectCredentials(projectRoot);
  const channelAuth = detectChannelAuth();
  const { registeredGroups, groupsByAgent } = loadRegisteredGroupsSummary();
  const {
    status,
    servicesSummary,
    configuredChannels,
    codexConfigured,
    reviewConfigured,
  } = buildVerifySummary(
    services,
    serviceDefs,
    credentials,
    channelAuth,
    registeredGroups,
    groupsByAgent,
  );

  logger.info({ status, channelAuth, servicesSummary }, 'Verification complete');

  emitStatus('VERIFY', {
    SERVICES: JSON.stringify(servicesSummary),
    // Legacy field (keep for backward compatibility)
    SERVICE: services[0].status,
    CREDENTIALS: credentials,
    CONFIGURED_CHANNELS: configuredChannels.join(','),
    CHANNEL_AUTH: JSON.stringify(channelAuth),
    REGISTERED_GROUPS: registeredGroups,
    GROUPS_BY_AGENT: JSON.stringify(groupsByAgent),
    CODEX_CONFIGURED: codexConfigured,
    REVIEW_CONFIGURED: reviewConfigured,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
