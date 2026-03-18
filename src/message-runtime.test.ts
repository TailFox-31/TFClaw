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
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid === chatJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setTyping: vi.fn().mockResolvedValue(undefined),
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

  it('streams Codex progress as a normal room message and only marks idle after the turn settles', async () => {
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

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-progress',
      reason: 'messages',
    });

    expect(result).toBe(true);
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
  });

  it('keeps progress separate from the final Codex answer', async () => {
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

    const result = await runtime.processGroupMessages(chatJid, {
      runId: 'run-final',
      reason: 'messages',
    });

    expect(result).toBe(true);
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      1,
      chatJid,
      '테스트를 돌리는 중입니다.',
    );
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      2,
      chatJid,
      '테스트가 끝났습니다.',
    );
    expect(notifyIdle).toHaveBeenCalledTimes(1);
    expect(notifyIdle).toHaveBeenCalledWith(chatJid, 'run-final');
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
    expect(channel.sendMessage).toHaveBeenCalledWith(
      chatJid,
      '중간 진행상황입니다.',
    );
    expect(lastAgentTimestamps[chatJid]).toBe('2026-03-19T00:00:00.000Z');
    expect(saveState).toHaveBeenCalled();
  });
});
