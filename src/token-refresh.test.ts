import { describe, expect, it } from 'vitest';

import { shouldStartTokenRefreshLoop } from './token-refresh.js';

describe('shouldStartTokenRefreshLoop', () => {
  it('starts refresh for the Claude service', () => {
    expect(shouldStartTokenRefreshLoop('claude-code')).toBe(true);
  });

  it('skips refresh for the Codex service', () => {
    expect(shouldStartTokenRefreshLoop('codex')).toBe(false);
  });
});
