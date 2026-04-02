import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildRoomUsageEstimateLines,
  collectClaudeRoomUsageSummary,
  collectCodexRoomUsageSummary,
} from './room-usage-estimator.js';

const tempDirs: string[] = [];

function makeTempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ejclaw-room-usage-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('collectClaudeRoomUsageSummary', () => {
  it('aggregates recent assistant usage per room and de-duplicates by message id', () => {
    const sessionsDir = makeTempSessionsDir();
    const filePath = path.join(
      sessionsDir,
      'dev-room',
      'services',
      'claude',
      '.claude',
      'projects',
      'proj',
      'session.jsonl',
    );
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const recentThinking = {
      type: 'assistant',
      timestamp: '2026-04-02T00:10:00.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
      },
    };
    const recentFinal = {
      type: 'assistant',
      timestamp: '2026-04-02T00:10:05.000Z',
      message: {
        id: 'msg-1',
        role: 'assistant',
        usage: {
          input_tokens: 10,
          output_tokens: 7,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
      },
    };
    const secondResponse = {
      type: 'assistant',
      timestamp: '2026-04-02T01:00:00.000Z',
      message: {
        id: 'msg-2',
        role: 'assistant',
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    };
    const oldResponse = {
      type: 'assistant',
      timestamp: '2026-03-30T01:00:00.000Z',
      message: {
        id: 'old-msg',
        role: 'assistant',
        usage: {
          input_tokens: 999,
          output_tokens: 999,
          cache_creation_input_tokens: 999,
          cache_read_input_tokens: 999,
        },
      },
    };

    fs.writeFileSync(
      filePath,
      [recentThinking, recentFinal, secondResponse, oldResponse]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );

    const summary = collectClaudeRoomUsageSummary({
      baseSessionsDir: sessionsDir,
      now: Date.parse('2026-04-02T02:00:00.000Z'),
      roomNameByFolder: { 'dev-room': '개발-1실' },
    });

    expect(summary.rooms).toHaveLength(1);
    expect(summary.rooms[0]?.name).toBe('개발-1실');
    expect(summary.rooms[0]?.metrics.inputTokens).toBe(15);
    expect(summary.rooms[0]?.metrics.outputTokens).toBe(9);
    expect(summary.rooms[0]?.metrics.cacheTokens).toBe(120);
    expect(summary.rooms[0]?.metrics.totalTokens).toBe(144);
    expect(summary.rooms[0]?.metrics.responseCount).toBe(2);
    expect(summary.totals.totalTokens).toBe(144);
  });
});

describe('collectCodexRoomUsageSummary', () => {
  it('extracts recent completed response usage from Codex sqlite logs', () => {
    const sessionsDir = makeTempSessionsDir();
    const dbPath = path.join(
      sessionsDir,
      'monitor-room',
      'services',
      'claude',
      '.codex',
      'logs_1.sqlite',
    );
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        ts_nanos INTEGER,
        level TEXT,
        target TEXT,
        feedback_log_body TEXT,
        module_path TEXT,
        file TEXT,
        line INTEGER,
        thread_id TEXT,
        process_uuid TEXT,
        estimated_bytes INTEGER
      );
    `);

    const completedEvent = {
      type: 'response.completed',
      response: {
        id: 'resp-1',
        completed_at: 1775086800,
        usage: {
          input_tokens: 120,
          output_tokens: 80,
          total_tokens: 200,
          output_tokens_details: {
            reasoning_tokens: 25,
          },
        },
      },
    };
    db.prepare(
      `INSERT INTO logs (ts, level, target, feedback_log_body)
       VALUES (?, ?, ?, ?)`,
    ).run(
      1775086800,
      'TRACE',
      'codex_api::endpoint::responses_websocket',
      `prefix websocket event: ${JSON.stringify(completedEvent)}`,
    );
    db.close();

    const summary = collectCodexRoomUsageSummary({
      baseSessionsDir: sessionsDir,
      now: Date.parse('2026-04-02T02:00:00.000Z'),
      roomNameByFolder: { 'monitor-room': '모니터링룸' },
    });

    expect(summary.rooms).toHaveLength(1);
    expect(summary.rooms[0]?.name).toBe('모니터링룸');
    expect(summary.rooms[0]?.metrics.inputTokens).toBe(120);
    expect(summary.rooms[0]?.metrics.outputTokens).toBe(80);
    expect(summary.rooms[0]?.metrics.reasoningTokens).toBe(25);
    expect(summary.rooms[0]?.metrics.totalTokens).toBe(200);
    expect(summary.rooms[0]?.metrics.responseCount).toBe(1);
  });
});

describe('buildRoomUsageEstimateLines', () => {
  it('renders both Claude and Codex room summaries', () => {
    const lines = buildRoomUsageEstimateLines({
      claude: {
        provider: 'claude',
        sinceMs: 24 * 60 * 60 * 1000,
        totals: {
          inputTokens: 1500,
          outputTokens: 300,
          cacheTokens: 2400,
          reasoningTokens: 0,
          totalTokens: 4200,
          responseCount: 3,
          updatedAt: '2026-04-02T01:00:00.000Z',
        },
        rooms: [
          {
            provider: 'claude',
            folder: 'dev-room',
            name: '개발-1실',
            metrics: {
              inputTokens: 1500,
              outputTokens: 300,
              cacheTokens: 2400,
              reasoningTokens: 0,
              totalTokens: 4200,
              responseCount: 3,
              updatedAt: '2026-04-02T01:00:00.000Z',
            },
          },
        ],
      },
      codex: {
        provider: 'codex',
        sinceMs: 24 * 60 * 60 * 1000,
        totals: {
          inputTokens: 900,
          outputTokens: 200,
          cacheTokens: 0,
          reasoningTokens: 50,
          totalTokens: 1100,
          responseCount: 2,
          updatedAt: '2026-04-02T01:30:00.000Z',
        },
        rooms: [
          {
            provider: 'codex',
            folder: 'dev-room',
            name: '개발-1실',
            metrics: {
              inputTokens: 900,
              outputTokens: 200,
              cacheTokens: 0,
              reasoningTokens: 50,
              totalTokens: 1100,
              responseCount: 2,
              updatedAt: '2026-04-02T01:30:00.000Z',
            },
          },
        ],
      },
    });

    expect(lines[0]).toContain('방별 추정 사용량');
    expect(lines.some((line) => line.includes('Claude Σ'))).toBe(true);
    expect(lines.some((line) => line.includes('Codex Σ'))).toBe(true);
    expect(lines.some((line) => line.includes('개발-1실'))).toBe(true);
  });
});
