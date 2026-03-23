/**
 * Codex OAuth Token Rotation
 *
 * Rotates between multiple Codex (ChatGPT) OAuth accounts when
 * rate-limited. Each account is stored as a separate auth.json in
 * ~/.codex-accounts/{n}/auth.json.
 *
 * The active account's auth.json is copied to the session directory
 * before each agent spawn (existing behavior in agent-runner-environment).
 * On rate-limit, we rotate to the next account.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const STATE_FILE = path.join(DATA_DIR, 'codex-rotation-state.json');

interface CodexAccount {
  index: number;
  authPath: string;
  accountId: string;
  planType: string;
  rateLimitedUntil: number | null;
}

function parsePlanFromJwt(idToken: string): string {
  try {
    const parts = idToken.split('.');
    if (parts.length < 2) return '?';
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    return payload?.['https://api.openai.com/auth']?.chatgpt_plan_type || '?';
  } catch {
    return '?';
  }
}

const accounts: CodexAccount[] = [];
let currentIndex = 0;
let initialized = false;

const ACCOUNTS_DIR = path.join(os.homedir(), '.codex-accounts');

export function initCodexTokenRotation(): void {
  if (initialized) return;
  initialized = true;

  if (!fs.existsSync(ACCOUNTS_DIR)) {
    logger.info(
      { dir: ACCOUNTS_DIR },
      'Codex accounts dir not found, skipping',
    );
    return;
  }

  const dirs = fs
    .readdirSync(ACCOUNTS_DIR)
    .filter((d) => /^\d+$/.test(d))
    .sort((a, b) => parseInt(a) - parseInt(b));

  for (const dir of dirs) {
    const authPath = path.join(ACCOUNTS_DIR, dir, 'auth.json');
    if (!fs.existsSync(authPath)) continue;

    try {
      const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
      const accountId = data?.tokens?.account_id || `account-${dir}`;
      const planType = parsePlanFromJwt(data?.tokens?.id_token || '');
      accounts.push({
        index: accounts.length,
        authPath,
        accountId,
        planType,
        rateLimitedUntil: null,
      });
    } catch {
      logger.warn({ authPath }, 'Failed to parse codex account auth.json');
    }
  }

  if (accounts.length > 1) loadCodexState();
  logger.info(
    { count: accounts.length, dir: ACCOUNTS_DIR, activeIndex: currentIndex },
    `Codex token rotation: ${accounts.length} account(s) found`,
  );
}

function saveCodexState(): void {
  try {
    const state = {
      currentIndex,
      rateLimits: accounts.map((a) => a.rateLimitedUntil),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch { /* best effort */ }
}

function loadCodexState(): void {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const now = Date.now();
    if (typeof state.currentIndex === 'number' && state.currentIndex < accounts.length) {
      currentIndex = state.currentIndex;
    }
    if (Array.isArray(state.rateLimits)) {
      for (let i = 0; i < Math.min(state.rateLimits.length, accounts.length); i++) {
        const until = state.rateLimits[i];
        if (typeof until === 'number' && until > now) {
          accounts[i].rateLimitedUntil = until;
        }
      }
    }
    logger.info({ currentIndex, accountCount: accounts.length }, 'Codex rotation state restored');
  } catch { /* start fresh */ }
}

/** Get the auth.json path for the current active account. */
export function getActiveCodexAuthPath(): string | null {
  if (accounts.length === 0) return null;
  return accounts[currentIndex]?.authPath ?? null;
}

/**
 * Try to rotate to the next available Codex account.
 * Returns true if a fresh account was found.
 */
export function rotateCodexToken(): boolean {
  if (accounts.length <= 1) return false;

  const now = Date.now();
  accounts[currentIndex].rateLimitedUntil = now + 3_600_000;

  for (let i = 1; i < accounts.length; i++) {
    const idx = (currentIndex + i) % accounts.length;
    const acct = accounts[idx];
    if (!acct.rateLimitedUntil || acct.rateLimitedUntil <= now) {
      acct.rateLimitedUntil = null;
      currentIndex = idx;
      logger.info(
        {
          accountIndex: currentIndex,
          totalAccounts: accounts.length,
          accountId: acct.accountId,
        },
        `Codex rotated to account #${currentIndex + 1}/${accounts.length}`,
      );
      saveCodexState();
      return true;
    }
  }

  logger.warn('All Codex accounts are rate-limited');
  return false;
}

export function markCodexTokenHealthy(): void {
  if (accounts.length === 0) return;
  const acct = accounts[currentIndex];
  if (acct?.rateLimitedUntil) {
    acct.rateLimitedUntil = null;
    saveCodexState();
  }
}

export function getCodexAccountCount(): number {
  return accounts.length;
}

export function getAllCodexAccounts(): {
  index: number;
  accountId: string;
  planType: string;
  isActive: boolean;
  isRateLimited: boolean;
}[] {
  const now = Date.now();
  return accounts.map((a, i) => ({
    index: i,
    accountId: a.accountId,
    planType: a.planType,
    isActive: i === currentIndex,
    isRateLimited: Boolean(a.rateLimitedUntil && a.rateLimitedUntil > now),
  }));
}
