import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-runner.js', () => ({
  runAgentProcess: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('./config.js', () => ({
  isSessionCommandSenderAllowed: vi.fn(() => false),
}));

vi.mock('./db.js', () => ({
  getAllChats: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
  getLastHumanMessageTimestamp: vi.fn(() => null),
  getMessagesSince: vi.fn(),
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('./sender-allowlist.js', () => ({
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({})),
}));

vi.mock('./session-commands.js', () => ({
  extractSessionCommand: vi.fn(() => null),
  handleSessionCommand: vi.fn(async () => ({ handled: false })),
  isSessionCommandAllowed: vi.fn(() => true),
  isSessionCommandControlMessage: vi.fn(() => false),
}));

import * as agentRunner from './agent-runner.js';
import * as db from './db.js';
import { createMessageRuntime } from './message-runtime.js';
import type { Channel, RegisteredGroup } from './types.js';

function makeGroup(agentType: 'claude-code' | 'codex'): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: `test-${agentType}`,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    agentType,
  };
}

function makeChannel(chatJid: string): Channel {
  return {
    name: 'discord',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid === chatJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

describe('createMessageRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears Claude sessions and closes stdin immediately on poisoned output', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('claude-code');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();
    const persistSession = vi.fn();
    const clearSession = vi.fn();
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-18T09:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result:
            'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
          newSessionId: 'session-123',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-123',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession,
      clearSession,
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-1',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(persistSession).toHaveBeenCalledWith(group.folder, 'session-123');
    expect(clearSession).toHaveBeenCalledWith(group.folder);
    expect(closeStdin).toHaveBeenCalledWith(chatJid, {
      runId: 'run-1',
      reason: 'poisoned-session',
    });
    expect(notifyIdle).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('2026-03-18T09:00:00.000Z');
    expect(saveState).toHaveBeenCalled();
  });

  it('does not apply the poisoned-session handling to Codex groups', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const closeStdin = vi.fn();
    const notifyIdle = vi.fn();
    const clearSession = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-18T09:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result:
            'An image in the conversation exceeds the dimension limit for many-image requests (2000px). Start a new session with fewer images.',
          newSessionId: 'session-456',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-456',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin,
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession,
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-2',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(clearSession).not.toHaveBeenCalled();
    expect(closeStdin).not.toHaveBeenCalled();
    expect(notifyIdle).toHaveBeenCalledWith(chatJid, 'run-2');
  });

  it('tracks Codex progress in one editable message and promotes the last progress when the run ends without a final phase', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const notifyIdle = vi.fn();
    const persistSession = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: 'CI 상태 확인 중입니다.',
          newSessionId: 'session-progress',
        });
        expect(notifyIdle).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-progress',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession,
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        'CI 상태 확인 중입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        'CI 상태 확인 중입니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        'CI 상태 확인 중입니다.',
      );
      expect(notifyIdle).toHaveBeenCalledTimes(1);
      expect(notifyIdle).toHaveBeenCalledWith(chatJid, 'run-progress');
      expect(persistSession).toHaveBeenCalledWith(
        group.folder,
        'session-progress',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('formats longer Codex progress durations with minutes and hours', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '오래 걸리는 작업입니다.',
          newSessionId: 'session-long-progress',
        });
        await vi.advanceTimersByTimeAsync(70_000);
        expect(channel.editMessage).toHaveBeenLastCalledWith(
          chatJid,
          'progress-1',
          '오래 걸리는 작업입니다.\n\n1분 10초',
        );
        await vi.advanceTimersByTimeAsync(50_000);
        expect(channel.editMessage).toHaveBeenLastCalledWith(
          chatJid,
          'progress-1',
          '오래 걸리는 작업입니다.\n\n2분 0초',
        );
        await vi.advanceTimersByTimeAsync(3_480_000);
        expect(channel.editMessage).toHaveBeenLastCalledWith(
          chatJid,
          'progress-1',
          '오래 걸리는 작업입니다.\n\n1시간 0분 0초',
        );
        await vi.advanceTimersByTimeAsync(70_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-long-progress',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-long-progress',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-long-progress',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        '오래 걸리는 작업입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenLastCalledWith(
        chatJid,
        'progress-1',
        '오래 걸리는 작업입니다.\n\n1시간 1분 10초',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps progress separate from the final Codex answer', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const notifyIdle = vi.fn();

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '테스트를 돌리는 중입니다.',
          newSessionId: 'session-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '테스트가 끝났습니다.',
          newSessionId: 'session-final',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-final',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle,
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-final',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        '테스트를 돌리는 중입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '테스트를 돌리는 중입니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '테스트가 끝났습니다.',
      );
      expect(notifyIdle).toHaveBeenCalledTimes(1);
      expect(notifyIdle).toHaveBeenCalledWith(chatJid, 'run-final');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a fresh tracked progress message for each Codex turn in one runner session', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!)
      .mockResolvedValueOnce('progress-1')
      .mockResolvedValueOnce('progress-2');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '첫 번째 진행상황입니다.',
          newSessionId: 'session-multi-turn',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '첫 번째 결과입니다.',
          newSessionId: 'session-multi-turn',
        });
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 진행상황입니다.',
          newSessionId: 'session-multi-turn',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '두 번째 결과입니다.',
          newSessionId: 'session-multi-turn',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-multi-turn',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-multi-turn',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        1,
        chatJid,
        '첫 번째 진행상황입니다.\n\n0초',
      );
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        2,
        chatJid,
        '두 번째 진행상황입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenNthCalledWith(
        1,
        chatJid,
        'progress-1',
        '첫 번째 진행상황입니다.\n\n10초',
      );
      expect(channel.editMessage).toHaveBeenNthCalledWith(
        2,
        chatJid,
        'progress-2',
        '두 번째 진행상황입니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        1,
        chatJid,
        '첫 번째 결과입니다.',
      );
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        2,
        chatJid,
        '두 번째 결과입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets tracked progress after a final output that becomes empty after formatting', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!)
      .mockResolvedValueOnce('progress-1')
      .mockResolvedValueOnce('progress-2');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '첫 번째 진행상황입니다.',
          newSessionId: 'session-empty-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '<internal>hidden final</internal>',
          newSessionId: 'session-empty-final',
        });
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 진행상황입니다.',
          newSessionId: 'session-empty-final',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-empty-final',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-empty-final',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-empty-final',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        1,
        chatJid,
        '첫 번째 진행상황입니다.\n\n0초',
      );
      expect(channel.sendAndTrack).toHaveBeenNthCalledWith(
        2,
        chatJid,
        '두 번째 진행상황입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenNthCalledWith(
        1,
        chatJid,
        'progress-1',
        '첫 번째 진행상황입니다.\n\n10초',
      );
      expect(channel.editMessage).toHaveBeenNthCalledWith(
        2,
        chatJid,
        'progress-2',
        '두 번째 진행상황입니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '두 번째 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes the last progress output to a final message when the agent completes without a final phase', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce('progress-1');

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '검증 중입니다.',
          newSessionId: 'session-progress-only',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '커밋은 정상 들어갔고 pre-commit도 통과했습니다.',
          newSessionId: 'session-progress-only',
        });
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-progress-only',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-progress-only',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-progress-only',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        '검증 중입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-1',
        '커밋은 정상 들어갔고 pre-commit도 통과했습니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenCalledWith(
        chatJid,
        '커밋은 정상 들어갔고 pre-commit도 통과했습니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('promotes progress-only output for a follow-up turn after a prior final in the same run', async () => {
    vi.useFakeTimers();
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(channel.sendAndTrack!).mockResolvedValueOnce(
      'progress-follow-up',
    );

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'final',
          result: '첫 번째 턴 최종 답변',
          newSessionId: 'session-follow-up',
        });
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '두 번째 턴 진행상황입니다.',
          newSessionId: 'session-follow-up',
        });
        await vi.advanceTimersByTimeAsync(10_000);
        await onOutput?.({
          status: 'success',
          result: null,
          newSessionId: 'session-follow-up',
        });
        return {
          status: 'success',
          result: null,
          newSessionId: 'session-follow-up',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => ({}),
      saveState: vi.fn(),
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    try {
      const result = await runtime.processGroupMessages(chatJid, {
        runId: 'run-follow-up-progress-only',
        reason: 'messages',
      });

      expect(result).toBe(true);
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        1,
        chatJid,
        '첫 번째 턴 최종 답변',
      );
      expect(channel.sendAndTrack).toHaveBeenCalledWith(
        chatJid,
        '두 번째 턴 진행상황입니다.\n\n0초',
      );
      expect(channel.editMessage).toHaveBeenCalledWith(
        chatJid,
        'progress-follow-up',
        '두 번째 턴 진행상황입니다.\n\n10초',
      );
      expect(channel.sendMessage).toHaveBeenNthCalledWith(
        2,
        chatJid,
        '두 번째 턴 진행상황입니다.',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not roll back when a streamed progress message was already posted before an error', async () => {
    const chatJid = 'group@test';
    const group = makeGroup('codex');
    const channel = makeChannel(chatJid);
    const saveState = vi.fn();
    const lastAgentTimestamps: Record<string, string> = {};

    vi.mocked(db.getMessagesSince).mockReturnValue([
      {
        id: 'msg-1',
        chat_jid: chatJid,
        sender: 'user@test',
        sender_name: 'User',
        content: 'hello',
        timestamp: '2026-03-19T00:00:00.000Z',
      },
    ]);

    vi.mocked(agentRunner.runAgentProcess).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          phase: 'progress',
          result: '중간 진행상황입니다.',
          newSessionId: 'session-error',
        });
        await onOutput?.({
          status: 'error',
          result: null,
          newSessionId: 'session-error',
          error: 'temporary failure',
        });
        return {
          status: 'error',
          result: null,
          newSessionId: 'session-error',
          error: 'temporary failure',
        };
      },
    );

    const runtime = createMessageRuntime({
      assistantName: 'Andy',
      idleTimeout: 1_000,
      pollInterval: 1_000,
      timezone: 'UTC',
      triggerPattern: /^@Andy\b/i,
      channels: [channel],
      queue: {
        registerProcess: vi.fn(),
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      getRegisteredGroups: () => ({ [chatJid]: group }),
      getSessions: () => ({}),
      getLastTimestamp: () => '',
      setLastTimestamp: vi.fn(),
      getLastAgentTimestamps: () => lastAgentTimestamps,
      saveState,
      persistSession: vi.fn(),
      clearSession: vi.fn(),
    });

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-progress-error',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      chatJid,
      '중간 진행상황입니다.\n\n0초',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('2026-03-19T00:00:00.000Z');
    expect(saveState).toHaveBeenCalled();
  });
});
