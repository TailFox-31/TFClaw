import { describe, expect, it } from 'vitest';

import { parseClaudeUsagePanel } from './claude-usage.js';

describe('parseClaudeUsagePanel', () => {
  it('parses session and weekly usage from Claude CLI panel output', () => {
    const sample = `
Settings: Status Config Usage
Loading usage data...

Current session
████ 4% used
Resets in 8m (Asia/Seoul)

Current week (all models)
███████████████████████████████████████ 78% used
Resets Mar 17 at 10pm (Asia/Seoul)

Current week (Sonnet only)
███ 6% used
Resets Mar 17 at 11pm (Asia/Seoul)

Extra usage
Extra usage not enabled • /extra-usage to enable
`;

    expect(parseClaudeUsagePanel(sample)).toEqual({
      five_hour: {
        utilization: 4,
        resets_at: 'Resets in 8m (Asia/Seoul)',
      },
      seven_day: {
        utilization: 78,
        resets_at: 'Resets Mar 17 at 10pm (Asia/Seoul)',
      },
    });
  });

  it('converts percent left into used percent', () => {
    const sample = `
Current session
60% left
Resets in 1h
`;

    expect(parseClaudeUsagePanel(sample)).toEqual({
      five_hour: {
        utilization: 40,
        resets_at: 'Resets in 1h',
      },
    });
  });
});
