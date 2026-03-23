/**
 * Claude Usage API
 *
 * Fetches usage data directly from the Anthropic OAuth API.
 * Supports multiple tokens for rotation-aware usage checking.
 */

import { logger } from './logger.js';
import { getCurrentToken, getAllTokens } from './token-rotation.js';

export interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  seven_day_sonnet?: { utilization: number; resets_at: string };
  seven_day_opus?: { utilization: number; resets_at: string };
}

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_TIMEOUT_MS = 10_000;

interface UsageApiResponse {
  five_hour?: { utilization: number; resets_at?: string };
  seven_day?: { utilization: number; resets_at?: string };
  seven_day_sonnet?: { utilization: number; resets_at?: string };
  seven_day_opus?: { utilization: number; resets_at?: string };
}

function mapWindow(w?: {
  utilization: number;
  resets_at?: string;
}): { utilization: number; resets_at: string } | undefined {
  if (!w) return undefined;
  return { utilization: w.utilization, resets_at: w.resets_at || '' };
}

async function fetchUsageForToken(
  token: string,
): Promise<ClaudeUsageData | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(USAGE_ENDPOINT, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'ejclaw/1.0',
      },
      signal: controller.signal,
    });

    if (res.status === 401) {
      logger.warn('Claude usage API: token expired or invalid (401)');
      return null;
    }
    if (res.status === 429) {
      logger.warn('Claude usage API: rate limited (429)');
      return null;
    }
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        `Claude usage API: unexpected status ${res.status}`,
      );
      return null;
    }

    const data = (await res.json()) as UsageApiResponse;

    return {
      five_hour: mapWindow(data.five_hour),
      seven_day: mapWindow(data.seven_day),
      seven_day_sonnet: mapWindow(data.seven_day_sonnet),
      seven_day_opus: mapWindow(data.seven_day_opus),
    };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logger.warn('Claude usage API: request timed out');
    } else {
      logger.warn({ err }, 'Claude usage API: fetch failed');
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch Claude usage via the OAuth API.
 * Uses the current active token from rotation.
 */
export async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  const token = getCurrentToken() || process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) {
    logger.debug('No Claude OAuth token available for usage check');
    return null;
  }
  return fetchUsageForToken(token);
}

export interface ClaudeAccountUsage {
  index: number;
  masked: string;
  isActive: boolean;
  isRateLimited: boolean;
  usage: ClaudeUsageData | null;
}

/**
 * Fetch usage for ALL configured tokens.
 * Returns per-account usage for dashboard display.
 */
export async function fetchAllClaudeUsage(): Promise<ClaudeAccountUsage[]> {
  const allTokens = getAllTokens();
  logger.debug({ tokenCount: allTokens.length }, 'fetchAllClaudeUsage called');
  if (allTokens.length === 0) {
    // Single token fallback
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) return [];
    const usage = await fetchUsageForToken(token);
    return [
      {
        index: 0,
        masked: `${token.slice(0, 20)}...${token.slice(-4)}`,
        isActive: true,
        isRateLimited: false,
        usage,
      },
    ];
  }

  const results: ClaudeAccountUsage[] = [];
  for (const t of allTokens) {
    const usage = await fetchUsageForToken(t.token);
    results.push({
      index: t.index,
      masked: t.masked,
      isActive: t.isActive,
      isRateLimited: t.isRateLimited,
      usage,
    });
  }
  return results;
}

// Legacy alias
export const fetchClaudeUsageViaCli = fetchClaudeUsage;
