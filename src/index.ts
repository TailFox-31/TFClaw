import { ChildProcess, execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  SERVICE_AGENT_TYPE,
  isSessionCommandSenderAllowed,
  STATUS_CHANNEL_ID,
  STATUS_UPDATE_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  USAGE_UPDATE_INTERVAL,
} from './config.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  AgentOutput,
  runAgentProcess,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './agent-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastHumanMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  isPairedRoomJid,
  setRegisteredGroup,
  setRouterState,
  updateRegisteredGroupName,
  deleteSession,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { filterProcessableMessages } from './bot-message-filter.js';
import { GroupQueue } from './group-queue.js';
import { readEnvFile } from './env.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  extractSessionCommand,
  handleSessionCommand,
  isSessionCommandAllowed,
} from './session-commands.js';
import { shouldResetSessionOnAgentFailure } from './session-recovery.js';
import {
  readStatusSnapshots,
  writeStatusSnapshot,
} from './status-dashboard.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, ChannelMeta, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

function advanceLastAgentCursor(chatJid: string, timestamp: string): void {
  lastAgentTimestamp[chatJid] = timestamp;
  saveState();
}

function getProcessableMessages(
  chatJid: string,
  messages: NewMessage[],
  channel?: import('./types.js').Channel,
): NewMessage[] {
  const isOwn = channel?.isOwnMessage?.bind(channel);
  return filterProcessableMessages(messages, isPairedRoomJid(chatJid), isOwn);
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  // Load only this service's registrations. The DB can hold both
  // claude-code and codex rows for the same Discord JID.
  registeredGroups = getAllRegisteredGroups(SERVICE_AGENT_TYPE);
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      agentType: SERVICE_AGENT_TYPE,
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function clearSession(groupFolder: string): void {
  delete sessions[groupFolder];
  deleteSession(groupFolder);
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./agent-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const rawMissedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );
  const missedMessages = getProcessableMessages(
    chatJid,
    rawMissedMessages,
    channel,
  );

  if (missedMessages.length === 0) {
    const lastIgnored = rawMissedMessages[rawMissedMessages.length - 1];
    if (lastIgnored) {
      advanceLastAgentCursor(chatJid, lastIgnored.timestamp);
    }
    return true;
  }

  // --- Session command interception (before trigger check) ---
  const cmdResult = await handleSessionCommand({
    missedMessages,
    isMainGroup,
    groupName: group.name,
    triggerPattern: TRIGGER_PATTERN,
    timezone: TIMEZONE,
    deps: {
      sendMessage: (text) => channel.sendMessage(chatJid, text),
      setTyping: (typing) =>
        channel.setTyping?.(chatJid, typing) ?? Promise.resolve(),
      runAgent: (prompt, onOutput) =>
        runAgent(group, prompt, chatJid, onOutput),
      closeStdin: () => queue.closeStdin(chatJid),
      clearSession: () => clearSession(group.folder),
      advanceCursor: (ts) => {
        advanceLastAgentCursor(chatJid, ts);
      },
      formatMessages,
      isAdminSender: (msg) => isSessionCommandSenderAllowed(msg.sender),
      canSenderInteract: (msg) => {
        const hasTrigger = TRIGGER_PATTERN.test(msg.content.trim());
        const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
        return (
          isMainGroup ||
          !reqTrigger ||
          (hasTrigger &&
            (msg.is_from_me ||
              isTriggerAllowed(chatJid, msg.sender, loadSenderAllowlist())))
        );
      },
    },
  });
  if (cmdResult.handled) return cmdResult.success;
  // --- End session command interception ---

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) {
      return true;
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  advanceLastAgentCursor(
    chatJid,
    missedMessages[missedMessages.length - 1].timestamp,
  );

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing agent stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  let hadError = false;
  let latestProgressText: string | null = null;
  let latestProgressRendered: string | null = null;
  let progressMessageId: string | null = null;
  let progressStartedAt: number | null = null;
  let progressTicker: ReturnType<typeof setInterval> | null = null;
  let finalOutputSentToUser = false;
  let progressOutputSentToUser = false;
  let poisonedSessionDetected = false;
  const isClaudeCodeAgent =
    (group.agentType || 'claude-code') === 'claude-code';

  const clearProgressTicker = () => {
    if (progressTicker) {
      clearInterval(progressTicker);
      progressTicker = null;
    }
  };

  const renderProgressMessage = (text: string) => {
    const elapsedSeconds =
      progressStartedAt === null
        ? 0
        : Math.floor((Date.now() - progressStartedAt) / 10_000) * 10;
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    const seconds = elapsedSeconds % 60;
    const elapsedParts: string[] = [];

    if (hours > 0) elapsedParts.push(`${hours}시간`);
    if (minutes > 0) elapsedParts.push(`${minutes}분`);
    elapsedParts.push(`${seconds}초`);

    return `${text}\n\n${elapsedParts.join(' ')}`;
  };

  const syncTrackedProgressMessage = async () => {
    if (!progressMessageId || !channel.editMessage || !latestProgressText) {
      return;
    }

    const rendered = renderProgressMessage(latestProgressText);
    if (rendered === latestProgressRendered) {
      return;
    }

    try {
      await channel.editMessage(chatJid, progressMessageId, rendered);
      latestProgressRendered = rendered;
    } catch {
      clearProgressTicker();
      progressMessageId = null;
    }
  };

  const ensureProgressTicker = () => {
    if (!progressMessageId || !channel.editMessage || progressTicker) {
      return;
    }

    progressTicker = setInterval(() => {
      void syncTrackedProgressMessage();
    }, 10_000);
  };

  const finalizeProgressMessage = async () => {
    await syncTrackedProgressMessage();
    clearProgressTicker();
  };

  const sendProgressMessage = async (text: string) => {
    if (!text || text === latestProgressText) {
      return;
    }

    latestProgressText = text;
    if (progressStartedAt === null) {
      progressStartedAt = Date.now();
    }
    const rendered = renderProgressMessage(text);

    if (progressMessageId && channel.editMessage) {
      await syncTrackedProgressMessage();
      progressOutputSentToUser = true;
      return;
    }

    if (!channel.sendAndTrack) {
      return;
    }

    progressMessageId = await channel.sendAndTrack(chatJid, rendered);
    if (progressMessageId) {
      latestProgressRendered = rendered;
      ensureProgressTicker();
      progressOutputSentToUser = true;
    }
  };

  await channel.setTyping?.(chatJid, true);

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    if (
      isClaudeCodeAgent &&
      shouldResetSessionOnAgentFailure(result) &&
      !poisonedSessionDetected
    ) {
      poisonedSessionDetected = true;
      hadError = true;
      clearSession(group.folder);
      queue.closeStdin(chatJid);
      logger.warn(
        { group: group.name, chatJid },
        'Detected poisoned Claude session from streamed output, forcing close',
      );
    }

    if (result.result) {
      const raw =
        typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (result.phase === 'progress') {
        if (text) {
          await sendProgressMessage(text);
        }
        return;
      }
      if (text) {
        await finalizeProgressMessage();
        await channel.sendMessage(chatJid, text);
        finalOutputSentToUser = true;
      }
    } else {
      await finalizeProgressMessage();
    }

    // Always clear typing and reset idle timer on any output (including null results)
    await channel.setTyping?.(chatJid, false);
    if (!poisonedSessionDetected) {
      resetIdleTimer();
    }

    if (result.status === 'success' && !poisonedSessionDetected) {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping?.(chatJid, false);

  if (output === 'error') {
    hadError = true;
  }

  clearProgressTicker();

  if (idleTimer) clearTimeout(idleTimer);

  if (hadError) {
    if (finalOutputSentToUser || progressOutputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: AgentOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for agent to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: AgentOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runAgentProcess(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, processName) =>
        queue.registerProcess(chatJid, proc, processName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent process error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

// ── Status & Usage Dashboards ───────────────────────────────────

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}m${rem.toString().padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h${m.toString().padStart(2, '0')}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d${remH}h`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)}GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)}MB`;
  return `${(bytes / 1024).toFixed(0)}KB`;
}

function usageEmoji(pct: number): string {
  if (pct >= 80) return '🔴';
  if (pct >= 50) return '🟡';
  return '🟢';
}

function formatResetKST(value: string | number): string {
  try {
    // Handle unix timestamp (seconds) or ISO string
    const date =
      typeof value === 'number' ? new Date(value * 1000) : new Date(value);
    return date.toLocaleString('ko-KR', {
      timeZone: 'Asia/Seoul',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

const STATUS_ICONS: Record<string, string> = {
  processing: '🟡',
  idle: '🟢',
  waiting: '🔵',
  inactive: '⚪',
};

let statusMessageId: string | null = null;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for compat
let usageMessageId: string | null = null;
let cachedUsageContent: string = '';
let cachedClaudeUsageData: ClaudeUsageData | null = null;

// Cache for Discord channel metadata (name, position, category)
let channelMetaCache = new Map<string, ChannelMeta>();
let channelMetaLastRefresh = 0;
const CHANNEL_META_REFRESH_MS = 300000; // 5 minutes
const STATUS_SNAPSHOT_MAX_AGE_MS = 60000;

async function refreshChannelMeta(): Promise<void> {
  const now = Date.now();
  if (now - channelMetaLastRefresh < CHANNEL_META_REFRESH_MS) return;

  const ch = channels.find(
    (c) => c.name.startsWith('discord') && c.isConnected() && c.getChannelMeta,
  );
  if (!ch?.getChannelMeta) return;

  // Include jids from both local registeredGroups and other service snapshots
  const localJids = Object.keys(registeredGroups).filter((j) =>
    j.startsWith('dc:'),
  );
  const snapshotJids = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS)
    .flatMap((s) => s.entries.map((e) => e.jid))
    .filter((j) => j.startsWith('dc:'));
  const jids = [...new Set([...localJids, ...snapshotJids])];
  try {
    channelMetaCache = await ch.getChannelMeta(jids);
    channelMetaLastRefresh = now;

    // Auto-sync DB group names with Discord channel names
    for (const [jid, meta] of channelMetaCache) {
      if (!meta.name) continue;
      const group = registeredGroups[jid];
      if (group && group.name !== meta.name) {
        logger.info(
          { jid, oldName: group.name, newName: meta.name },
          'Syncing group name to Discord channel name',
        );
        group.name = meta.name;
        updateRegisteredGroupName(jid, meta.name);
      }
    }
  } catch (err) {
    logger.debug({ err }, 'Failed to refresh channel metadata');
  }
}

function getStatusLabel(s: {
  status: 'processing' | 'idle' | 'waiting' | 'inactive';
  elapsedMs: number | null;
  pendingMessages: boolean;
  pendingTasks: number;
}): string {
  if (s.status === 'processing')
    return `처리 중 (${formatElapsed(s.elapsedMs || 0)})`;
  if (s.status === 'idle') return '대기 중';
  if (s.status === 'waiting')
    return s.pendingTasks > 0
      ? `큐 대기 (태스크 ${s.pendingTasks}개)`
      : '큐 대기 (메시지)';
  return '비활성';
}

function getAgentDisplayName(agentType: 'claude-code' | 'codex'): string {
  return agentType === 'codex' ? '코덱스' : '클코';
}

function formatRoomName(
  jid: string,
  meta: ChannelMeta | undefined,
  fallbackName: string | undefined,
  chatName: string | undefined,
): string {
  const base =
    meta?.name ||
    (chatName && chatName !== jid ? chatName : undefined) ||
    (fallbackName && fallbackName !== jid ? fallbackName : undefined) ||
    jid;

  if (jid.startsWith('dc:') && base !== jid && !base.startsWith('#')) {
    return `#${base}`;
  }
  return base;
}

function writeLocalStatusSnapshot(): void {
  const jids = Object.keys(registeredGroups);
  const statuses = queue.getStatuses(jids);

  writeStatusSnapshot({
    agentType: SERVICE_AGENT_TYPE,
    assistantName: ASSISTANT_NAME,
    updatedAt: new Date().toISOString(),
    entries: statuses
      .map((status) => {
        const group = registeredGroups[status.jid];
        if (!group) return null;
        return {
          jid: status.jid,
          name: group.name,
          folder: group.folder,
          agentType: (group.agentType || SERVICE_AGENT_TYPE) as
            | 'claude-code'
            | 'codex',
          status: status.status,
          elapsedMs: status.elapsedMs,
          pendingMessages: status.pendingMessages,
          pendingTasks: status.pendingTasks,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          jid: string;
          name: string;
          folder: string;
          agentType: 'claude-code' | 'codex';
          status: 'processing' | 'idle' | 'waiting' | 'inactive';
          elapsedMs: number | null;
          pendingMessages: boolean;
          pendingTasks: number;
        } => Boolean(entry),
      ),
  });
}

function buildStatusContent(): string {
  const snapshots = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS);
  const chatNameByJid = new Map(
    getAllChats().map((chat) => [chat.jid, chat.name]),
  );

  // Collect all entries keyed by jid, with agent type info
  interface RoomEntry {
    agentType: 'claude-code' | 'codex';
    status: 'processing' | 'idle' | 'waiting' | 'inactive';
    elapsedMs: number | null;
    pendingMessages: boolean;
    pendingTasks: number;
    name: string;
    meta: ChannelMeta | undefined;
  }
  const byJid = new Map<string, RoomEntry[]>();

  for (const snapshot of snapshots) {
    const agentType = snapshot.agentType as 'claude-code' | 'codex';
    for (const entry of snapshot.entries) {
      const arr = byJid.get(entry.jid) || [];
      arr.push({
        agentType,
        status: entry.status,
        elapsedMs: entry.elapsedMs,
        pendingMessages: entry.pendingMessages,
        pendingTasks: entry.pendingTasks,
        name: entry.name,
        meta: channelMetaCache.get(entry.jid),
      });
      byJid.set(entry.jid, arr);
    }
  }

  // Group by category, then render rooms
  interface RoomInfo {
    jid: string;
    name: string;
    meta: ChannelMeta | undefined;
    agents: RoomEntry[];
  }
  const categoryMap = new Map<string, RoomInfo[]>();
  let totalActive = 0;
  let totalRooms = 0;

  for (const [jid, agents] of byJid) {
    const meta = agents[0]?.meta;
    const cat = meta?.category || '기타';
    if (!categoryMap.has(cat)) categoryMap.set(cat, []);
    categoryMap.get(cat)!.push({
      jid,
      name: formatRoomName(
        jid,
        meta,
        agents.find((agent) => agent.name && agent.name !== jid)?.name,
        chatNameByJid.get(jid),
      ),
      meta,
      agents,
    });
    totalRooms++;
    if (agents.some((a) => a.status === 'processing')) totalActive++;
  }

  const sortedCategories = [...categoryMap.entries()].sort((a, b) => {
    const posA = a[1][0]?.meta?.categoryPosition ?? 999;
    const posB = b[1][0]?.meta?.categoryPosition ?? 999;
    return posA - posB;
  });

  const sections: string[] = [];
  for (const [catName, rooms] of sortedCategories) {
    rooms.sort((a, b) => (a.meta?.position ?? 999) - (b.meta?.position ?? 999));

    const roomLines: string[] = [];
    for (const room of rooms) {
      // Sort agents: claude-code first, codex second
      room.agents.sort((a, b) =>
        a.agentType === b.agentType
          ? 0
          : a.agentType === 'claude-code'
            ? -1
            : 1,
      );

      const agentParts = room.agents.map((a) => {
        const icon = STATUS_ICONS[a.status] || '⚪';
        const label = getStatusLabel(a);
        const tag = getAgentDisplayName(a.agentType);
        return `${tag} ${icon} ${label}`;
      });
      roomLines.push(`  **${room.name}** — ${agentParts.join(' | ')}`);
    }

    if (channelMetaCache.size > 0 && catName !== '기타') {
      sections.push(`📁 **${catName}**\n${roomLines.join('\n')}`);
    } else {
      sections.push(roomLines.join('\n'));
    }
  }

  const header = `**📊 에이전트 상태** — 활성 ${totalActive} / ${totalRooms}`;
  return `${header}\n\n${sections.join('\n\n')}`;
}

// ── API Usage Fetchers ──────────────────────────────────────────

interface ClaudeUsageData {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
}

interface CodexRateLimit {
  limitId?: string;
  limitName: string | null;
  primary: { usedPercent: number; resetsAt: string | number };
  secondary: { usedPercent: number; resetsAt: string | number };
}

let usageApiBackoffUntil = 0;

async function fetchClaudeUsage(): Promise<ClaudeUsageData | null> {
  // Skip if in backoff period (after 429)
  if (Date.now() < usageApiBackoffUntil) {
    logger.debug('Skipping usage API call (backoff active)');
    return null;
  }

  try {
    const envToken = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    let token =
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      envToken.CLAUDE_CODE_OAUTH_TOKEN ||
      '';
    if (!token) {
      const configDir =
        process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
      const credsPath = path.join(configDir, '.credentials.json');
      if (!fs.existsSync(credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
      token = creds?.claudeAiOauth?.accessToken || '';
    }
    if (!token) return null;

    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) {
        // Back off for 10 minutes on rate limit
        usageApiBackoffUntil = Date.now() + 600_000;
        logger.warn(
          {
            status: 429,
            retryAfter: res.headers.get('retry-after'),
            body: body.slice(0, 200),
          },
          'Usage API rate limited (429), backing off 10min',
        );
      } else {
        logger.warn(
          { status: res.status, body: body.slice(0, 200) },
          'Usage API returned non-OK status',
        );
      }
      return null;
    }
    return (await res.json()) as ClaudeUsageData;
  } catch (err) {
    logger.debug({ err }, 'Usage API fetch failed');
    return null;
  }
}

async function fetchCodexUsage(): Promise<CodexRateLimit[] | null> {
  // Find codex binary
  const npmGlobalBin = path.join(os.homedir(), '.npm-global', 'bin', 'codex');
  const codexBin = fs.existsSync(npmGlobalBin) ? npmGlobalBin : 'codex';

  return new Promise((resolve) => {
    let done = false;
    const finish = (val: CodexRateLimit[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), 20000);

    let proc: ChildProcess;
    try {
      proc = spawn(codexBin, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...(process.env as Record<string, string>),
          PATH: [
            path.dirname(process.execPath),
            path.join(os.homedir(), '.npm-global', 'bin'),
            process.env.PATH || '',
          ].join(':'),
        },
      });
    } catch {
      resolve(null);
      return;
    }

    proc.on('error', () => finish(null));
    proc.on('close', () => finish(null));

    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1) {
            // Initialize done, query rate limits
            proc.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: 2,
                method: 'account/rateLimits/read',
                params: {},
              }) + '\n',
            );
          } else if (msg.id === 2 && msg.result) {
            // Extract rate limits from rateLimitsByLimitId object
            const byId = msg.result.rateLimitsByLimitId;
            if (byId && typeof byId === 'object') {
              finish(Object.values(byId) as CodexRateLimit[]);
            } else {
              finish(null);
            }
          }
        } catch {
          /* non-JSON line, skip */
        }
      }
    });

    // Send initialize
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'usage-monitor', version: '1.0' } },
      }) + '\n',
    );
  });
}

// ── Usage Dashboard Builder ─────────────────────────────────────

async function buildUsageContent(): Promise<string> {
  const lines: string[] = [];
  const activeSnapshots = readStatusSnapshots(STATUS_SNAPSHOT_MAX_AGE_MS);
  const hasActiveClaudeWork = activeSnapshots.some(
    (snapshot) =>
      snapshot.agentType === 'claude-code' &&
      snapshot.entries.some(
        (entry) => entry.status === 'processing' || entry.status === 'waiting',
      ),
  );

  const [liveClaudeUsage, codexUsage] = await Promise.all([
    hasActiveClaudeWork ? Promise.resolve(null) : fetchClaudeUsage(),
    fetchCodexUsage(),
  ]);
  const claudeUsage = liveClaudeUsage || cachedClaudeUsageData;
  const claudeUsageIsCached = !liveClaudeUsage && !!cachedClaudeUsageData;
  if (liveClaudeUsage) {
    cachedClaudeUsageData = liveClaudeUsage;
  }

  const bar = (pct: number) => {
    const filled = Math.round(pct / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  };

  lines.push('📊 *사용량*');

  type UsageRow = {
    name: string;
    h5pct: number;
    h5reset: string;
    d7pct: number;
    d7reset: string;
  };
  const rows: UsageRow[] = [];

  if (claudeUsage) {
    const h5 = claudeUsage.five_hour;
    const d7 = claudeUsage.seven_day;
    rows.push({
      name: claudeUsageIsCached ? 'Claude*' : 'Claude',
      h5pct: h5
        ? h5.utilization > 1
          ? Math.round(h5.utilization)
          : Math.round(h5.utilization * 100)
        : -1,
      h5reset: h5 ? formatResetKST(h5.resets_at) : '',
      d7pct: d7
        ? d7.utilization > 1
          ? Math.round(d7.utilization)
          : Math.round(d7.utilization * 100)
        : -1,
      d7reset: d7 ? formatResetKST(d7.resets_at) : '',
    });
  }

  if (codexUsage && Array.isArray(codexUsage)) {
    const relevant = codexUsage.filter(
      (limit) =>
        limit.primary.usedPercent > 0 || limit.secondary.usedPercent > 0,
    );
    const display = relevant.length > 0 ? relevant : codexUsage.slice(0, 1);
    for (const limit of display) {
      rows.push({
        name: 'Codex',
        h5pct: Math.round(limit.primary.usedPercent),
        h5reset: formatResetKST(limit.primary.resetsAt),
        d7pct: Math.round(limit.secondary.usedPercent),
        d7reset: formatResetKST(limit.secondary.resetsAt),
      });
    }
  }

  if (rows.length > 0) {
    lines.push('```');
    lines.push('        5-Hour             7-Day');
    for (const row of rows) {
      const h5 =
        row.h5pct >= 0
          ? `${bar(row.h5pct)} ${String(row.h5pct).padStart(3)}%`
          : '  —  ';
      const d7 =
        row.d7pct >= 0
          ? `${bar(row.d7pct)} ${String(row.d7pct).padStart(3)}%`
          : '  —  ';
      lines.push(`${row.name.padEnd(8)}${h5}   ${d7}`);
    }
    lines.push('```');
  } else {
    lines.push('_조회 불가_');
  }
  if (claudeUsageIsCached) {
    lines.push('_* Claude 사용량은 작업 중일 때는 캐시값 유지_');
  }
  lines.push('');

  lines.push('🖥️ *서버*');

  const loadAvg = os.loadavg();
  const cpuCount = os.cpus().length;
  const cpuPct = Math.round((loadAvg[1] / cpuCount) * 100);

  const totalMem = os.totalmem();
  const usedMem = totalMem - os.freemem();
  const memPct = Math.round((usedMem / totalMem) * 100);
  const memUsedGB = (usedMem / 1073741824).toFixed(1);
  const memTotalGB = (totalMem / 1073741824).toFixed(1);

  let diskPct = 0;
  let diskUsedGB = '?';
  let diskTotalGB = '?';
  try {
    const df = execSync('df -B1 / | tail -1', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const parts = df.split(/\s+/);
    const diskUsed = parseInt(parts[2], 10);
    const diskTotal = parseInt(parts[1], 10);
    diskPct = Math.round((diskUsed / diskTotal) * 100);
    diskUsedGB = (diskUsed / 1073741824).toFixed(0);
    diskTotalGB = (diskTotal / 1073741824).toFixed(0);
  } catch {
    /* ignore */
  }

  lines.push('```');
  lines.push(`${'CPU'.padEnd(8)}${bar(cpuPct)} ${String(cpuPct).padStart(3)}%`);
  lines.push(
    `${'Memory'.padEnd(8)}${bar(memPct)} ${String(memPct).padStart(3)}%  ${memUsedGB}/${memTotalGB}GB`,
  );
  lines.push(
    `${'Disk'.padEnd(8)}${bar(diskPct)} ${String(diskPct).padStart(3)}%  ${diskUsedGB}/${diskTotalGB}GB`,
  );
  lines.push(`${'Uptime'.padEnd(8)}${formatElapsed(os.uptime() * 1000)}`);
  lines.push('```');

  return lines.join('\n');
}

// ── Unified Dashboard Lifecycle ──────────────────────────────────

let usageUpdateInProgress = false;

async function refreshUsageCache(): Promise<void> {
  if (usageUpdateInProgress) return;
  usageUpdateInProgress = true;
  try {
    cachedUsageContent = await buildUsageContent();
  } catch {
    /* keep previous cache */
  } finally {
    usageUpdateInProgress = false;
  }
}

function buildUnifiedDashboard(): string {
  const status = buildStatusContent();
  const parts = [status];

  if (cachedUsageContent) {
    parts.push(cachedUsageContent);
  }

  parts.push(
    `_${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}_`,
  );
  return parts.join('\n\n');
}

async function startStatusDashboard(): Promise<void> {
  if (!STATUS_CHANNEL_ID) return;
  const isRenderer = SERVICE_AGENT_TYPE === 'claude-code';

  const statusJid = `dc:${STATUS_CHANNEL_ID}`;

  const findDiscordChannel = () =>
    channels.find((c) => c.name.startsWith('discord') && c.isConnected());

  // Initial usage fetch
  if (isRenderer) {
    await refreshUsageCache();
  }

  const updateStatus = async () => {
    writeLocalStatusSnapshot();
    if (!isRenderer) return;

    const ch = findDiscordChannel();
    if (!ch) return;

    try {
      await refreshChannelMeta();
      const content = buildUnifiedDashboard();

      if (statusMessageId && ch.editMessage) {
        await ch.editMessage(statusJid, statusMessageId, content);
      } else if (ch.sendAndTrack) {
        const id = await ch.sendAndTrack(statusJid, content);
        if (id) statusMessageId = id;
      }
    } catch (err) {
      logger.debug({ err }, 'Dashboard update failed');
      statusMessageId = null;
    }
  };

  // Status updates every 10s
  setInterval(updateStatus, STATUS_UPDATE_INTERVAL);
  await updateStatus();

  // Usage cache refreshes every 5min (only on renderer)
  if (isRenderer) {
    setInterval(refreshUsageCache, USAGE_UPDATE_INTERVAL);
  }

  logger.info(
    { channelId: STATUS_CHANNEL_ID, isRenderer, agentType: SERVICE_AGENT_TYPE },
    isRenderer
      ? 'Unified dashboard started'
      : 'Status snapshot updater started',
  );
}

// Legacy compat — now handled inside startStatusDashboard
async function startUsageDashboard(): Promise<void> {
  // Usage is now integrated into the unified dashboard
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const processableGroupMessages = getProcessableMessages(
            chatJid,
            groupMessages,
            channel,
          );

          if (processableGroupMessages.length === 0) {
            const lastIgnored = groupMessages[groupMessages.length - 1];
            if (lastIgnored) {
              advanceLastAgentCursor(chatJid, lastIgnored.timestamp);
            }
            continue;
          }

          // --- Bot-collaboration timeout ---
          // If all new messages are from bots, only process if a human
          // sent a message within the last 12 hours.
          const BOT_COLLAB_TIMEOUT_MS = 12 * 60 * 60 * 1000;
          const allFromBots = processableGroupMessages.every(
            (m) => m.is_from_me || !!m.is_bot_message,
          );
          if (allFromBots) {
            const lastHuman = getLastHumanMessageTimestamp(chatJid);
            if (
              !lastHuman ||
              Date.now() - new Date(lastHuman).getTime() > BOT_COLLAB_TIMEOUT_MS
            ) {
              logger.info(
                { chatJid, lastHuman },
                'Bot-collaboration timeout: no human message within 12h, skipping',
              );
              continue;
            }
          }
          // --- End bot-collaboration timeout ---

          // --- Session command interception (message loop) ---
          // Scan ALL messages in the batch for a session command.
          const loopCmdMsg = processableGroupMessages.find(
            (m) => extractSessionCommand(m.content, TRIGGER_PATTERN) !== null,
          );

          if (loopCmdMsg) {
            // Only close active agent if the sender is authorized — otherwise an
            // untrusted user could kill in-flight work by sending /compact (DoS).
            // closeStdin no-ops internally when no agent is active.
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
                isSessionCommandSenderAllowed(loopCmdMsg.sender),
              )
            ) {
              queue.closeStdin(chatJid);
            }
            // Enqueue so processGroupMessages handles auth + cursor advancement.
            // Don't pipe via IPC — slash commands need a fresh agent with
            // string prompt (not MessageStream) for SDK recognition.
            queue.enqueueMessageCheck(chatJid);
            continue;
          }
          // --- End session command interception ---

          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = processableGroupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const processablePending = getProcessableMessages(
            chatJid,
            allPending,
            channel,
          );
          const messagesToSend =
            processablePending.length > 0
              ? processablePending
              : processableGroupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active agent',
            );
            advanceLastAgentCursor(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            // Show typing indicator while the agent processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active agent — enqueue for a new one
            queue.enqueueMessageCheck(chatJid, group.folder);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const rawPending = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    );
    const recoveryChannel = findChannel(channels, chatJid);
    const pending = getProcessableMessages(
      chatJid,
      rawPending,
      recoveryChannel ?? undefined,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid, group.folder);
    } else if (rawPending.length > 0) {
      advanceLastAgentCursor(
        chatJid,
        rawPending[rawPending.length - 1].timestamp,
      );
    }
  }
}

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, processName, groupFolder) =>
      queue.registerProcess(groupJid, proc, processName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  // Purge old messages in status channel before creating fresh dashboards
  if (STATUS_CHANNEL_ID && SERVICE_AGENT_TYPE === 'claude-code') {
    const statusJid = `dc:${STATUS_CHANNEL_ID}`;
    const ch = channels.find(
      (c) => c.name.startsWith('discord') && c.isConnected() && c.purgeChannel,
    );
    if (ch?.purgeChannel) {
      await ch.purgeChannel(statusJid);
    }
  }
  await startStatusDashboard();
  await startUsageDashboard();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
